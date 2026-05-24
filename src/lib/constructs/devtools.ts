/**
 * Development Tools Constructs
 * Optional tools for development and debugging environments
 */

import { Construct } from "constructs";
import { DevToolsConfig } from "../core/types";
import { Deployment, IntOrString, Service } from "../k8s";

export interface DevToolsProps {
  namespace: string;
  appName: string;
  config: DevToolsConfig;
  /** Database connections for admin tools */
  databases?: Array<{
    type: "mysql" | "postgresql" | "mongodb" | "redis" | "valkey";
    host: string;
    port: number;
    username?: string;
    password?: string;
    database?: string;
    name?: string;
  }>;
  labels?: Record<string, string>;
}

/**
 * Database Administration Tool (WhoDB)
 * Only deployed in non-production environments
 */
export class DatabaseAdmin extends Construct {
  public readonly serviceName?: string;
  public readonly port?: number;

  constructor(scope: Construct, id: string, props: DevToolsProps) {
    super(scope, id);

    // Skip creation if not enabled
    if (!props.config.dbAdmin.enabled) {
      return;
    }

    this.serviceName = `${id}-service`;
    this.port = props.config.dbAdmin.port || 8080;

    const labels = {
      app: id,
      component: "dev-tools",
      "app.kubernetes.io/part-of": props.appName,
      ...props.labels,
    };

    // Build database configuration for WhoDB
    const dbConfig = props.databases || [];
    const whodbConfig = {
      databases: dbConfig.map((db) => ({
        name: db.name || `${db.type}-${db.host}`,
        type: db.type,
        host: db.host,
        port: db.port,
        ...(db.username ? { username: db.username } : {}),
        ...(db.password ? { password: db.password } : {}),
        ...(db.database ? { database: db.database } : {}),
      })),
    };

    // WhoDB Deployment
    new Deployment(this, "deployment", {
      metadata: {
        name: `${id}-deployment`,
        namespace: props.namespace,
        labels,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { app: id },
        },
        template: {
          metadata: {
            labels: { app: id },
          },
          spec: {
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              fsGroup: 2000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "whodb",
                image: props.config.dbAdmin.image || "clidey/whodb:latest",
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                imagePullPolicy:
                  props.config.dbAdmin.imagePullPolicy || "IfNotPresent",
                ports: [
                  {
                    name: "http",
                    containerPort: this.port,
                  },
                ],
                env: [
                  {
                    name: "WHODB_CONFIG",
                    value: JSON.stringify(whodbConfig),
                  },
                  {
                    name: "WHODB_HOST",
                    value: "0.0.0.0",
                  },
                  {
                    name: "WHODB_PORT",
                    value: this.port.toString(),
                  },
                ],
                readinessProbe: {
                  httpGet: {
                    path: "/",
                    port: IntOrString.fromNumber(this.port),
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  httpGet: {
                    path: "/",
                    port: IntOrString.fromNumber(this.port),
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
              },
            ],
          },
        },
      },
    });

    // WhoDB Service
    new Service(this, "service", {
      metadata: {
        name: this.serviceName,
        namespace: props.namespace,
        labels,
      },
      spec: {
        type: "ClusterIP",
        ports: [
          {
            name: "http",
            port: this.port,
            targetPort: IntOrString.fromNumber(this.port),
          },
        ],
        selector: { app: id },
      },
    });
  }

  /**
   * Get connection information for ingress/port-forwarding
   */
  getConnectionInfo(): { host: string; port: number; url: string } | null {
    if (!this.serviceName || !this.port) return null;

    return {
      host: this.serviceName,
      port: this.port,
      url: `http://${this.serviceName}:${this.port}`,
    };
  }
}

/**
 * Generic development tool construct
 * For other development tools like monitoring, debugging, etc.
 */
export class DevTool extends Construct {
  public readonly serviceName?: string;
  public readonly port?: number;

  constructor(
    scope: Construct,
    id: string,
    props: {
      namespace: string;
      appName: string;
      image: string;
      port: number;
      env?: Record<string, string>;
      enabled?: boolean;
      labels?: Record<string, string>;
    },
  ) {
    super(scope, id);

    // Skip creation if not enabled (default: true)
    if (props.enabled === false) {
      return;
    }

    this.serviceName = `${id}-service`;
    this.port = props.port;

    const labels = {
      app: id,
      component: "dev-tools",
      "app.kubernetes.io/part-of": props.appName,
      ...props.labels,
    };

    // Build environment variables
    const envVars = Object.entries(props.env || {}).map(([key, value]) => ({
      name: key,
      value,
    }));

    // Deployment
    new Deployment(this, "deployment", {
      metadata: {
        name: `${id}-deployment`,
        namespace: props.namespace,
        labels,
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { app: id },
        },
        template: {
          metadata: {
            labels: { app: id },
          },
          spec: {
            containers: [
              {
                name: id,
                image: props.image,
                ports: [
                  {
                    name: "http",
                    containerPort: this.port,
                  },
                ],
                ...(envVars.length > 0 ? { env: envVars } : {}),
                readinessProbe: {
                  httpGet: {
                    path: "/",
                    port: IntOrString.fromNumber(this.port),
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                },
              },
            ],
          },
        },
      },
    });

    // Service
    new Service(this, "service", {
      metadata: {
        name: this.serviceName,
        namespace: props.namespace,
        labels,
      },
      spec: {
        type: "ClusterIP",
        ports: [
          {
            name: "http",
            port: this.port,
            targetPort: IntOrString.fromNumber(this.port),
          },
        ],
        selector: { app: id },
      },
    });
  }
}
