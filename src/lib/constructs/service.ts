/**
 * Application Service Constructs
 * Reusable constructs for web services, APIs, and other application components
 */

import { Construct } from "constructs";
import { ServiceConfig } from "../core/types";
import { Deployment, IntOrString, Quantity, Service } from "../k8s";

export interface ApplicationServiceProps {
  namespace: string;
  appName: string;
  config: ServiceConfig;
  /** Optional: Override container command */
  command?: string[];
  /** Optional: Environment variables to inject */
  env?: Record<string, any>;
  /** Optional: envFrom references (ConfigMaps, Secrets) */
  envFrom?: Array<{
    configMapRef?: { name: string };
    secretRef?: { name: string };
  }>;
  /** Optional: Service type override */
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /** Optional: Additional labels */
  labels?: Record<string, string>;
  /** Optional: Node port for NodePort services */
  nodePort?: number;
  /** Optional: Init containers to run before the main container starts */
  initContainers?: any[];
}

/**
 * Generic application service construct
 * Can be used for APIs, web frontends, workers, etc.
 */
export class ApplicationService extends Construct {
  public readonly serviceName: string;
  public readonly deploymentName: string;
  public readonly port: number;

  constructor(scope: Construct, id: string, props: ApplicationServiceProps) {
    super(scope, id);

    this.serviceName = `${id}-service`;
    this.deploymentName = `${id}-deployment`;
    this.port = props.config.port;

    const labels = {
      app: id,
      component: "application",
      "app.kubernetes.io/part-of": props.appName,
      ...props.labels,
    };

    // Build environment variables array
    const envVars: Array<{
      name: string;
      value?: string;
      valueFrom?: any;
    }> = [];

    // Track keys already added to avoid duplicates (props.env and props.config.env
    // both originate from the same services.<name>.env YAML field when called from
    // FullStackChart, so iterating both causes duplicate container env entries).
    const addedKeys = new Set<string>();

    // Add individual environment variables
    if (props.env) {
      Object.entries(props.env).forEach(([key, value]) => {
        if (typeof value === "string") {
          envVars.push({ name: key, value });
        } else if (value && typeof value === "object" && "value" in value) {
          envVars.push({ name: key, value: value.value });
        } else if (value && typeof value === "object" && "valueFrom" in value) {
          envVars.push({ name: key, valueFrom: value.valueFrom });
        }
        addedKeys.add(key);
      });
    }

    // Add config-specific environment variables, skipping any already added above.
    if (props.config.env) {
      Object.entries(props.config.env).forEach(([key, value]) => {
        if (!addedKeys.has(key)) {
          envVars.push({ name: key, value });
        }
      });
    }

    // Create deployment
    new Deployment(this, "deployment", {
      metadata: {
        name: this.deploymentName,
        namespace: props.namespace,
        labels,
      },
      spec: {
        replicas: props.config.replicas,
        selector: {
          matchLabels: { app: id },
        },
        template: {
          metadata: {
            labels: { app: id },
          },
          spec: {
            ...(props.initContainers && props.initContainers.length > 0
              ? { initContainers: props.initContainers }
              : {}),
            containers: [
              {
                name: id,
                image: props.config.image,
                imagePullPolicy: props.config.imagePullPolicy ?? "IfNotPresent",
                ...(props.command && props.command.length > 0
                  ? { command: props.command }
                  : {}),
                ports: [
                  {
                    name: "http",
                    containerPort: this.port,
                  },
                ],
                ...(envVars.length > 0 ? { env: envVars } : {}),
                ...(props.envFrom && props.envFrom.length > 0
                  ? { envFrom: props.envFrom }
                  : {}),
                ...(props.config.resources
                  ? {
                      resources: {
                        ...(props.config.resources.limits
                          ? {
                              limits: {
                                cpu: Quantity.fromString(
                                  props.config.resources.limits.cpu,
                                ),
                                memory: Quantity.fromString(
                                  props.config.resources.limits.memory,
                                ),
                              },
                            }
                          : {}),
                        ...(props.config.resources.requests
                          ? {
                              requests: {
                                cpu: Quantity.fromString(
                                  props.config.resources.requests.cpu,
                                ),
                                memory: Quantity.fromString(
                                  props.config.resources.requests.memory,
                                ),
                              },
                            }
                          : {}),
                      },
                    }
                  : {}),
                ...(props.config.healthCheck
                  ? {
                      // Readiness probe: checks DB connectivity before accepting traffic
                      readinessProbe: {
                        httpGet: {
                          path: props.config.healthCheck.replace(/\/?$/, '/ready'),
                          port: IntOrString.fromNumber(this.port),
                        },
                        initialDelaySeconds: 10,
                        periodSeconds: 5,
                        failureThreshold: 3,
                      },
                      // Liveness probe: lightweight check — just confirms process is alive
                      livenessProbe: {
                        httpGet: {
                          path: props.config.healthCheck.replace(/\/?$/, '/live'),
                          port: IntOrString.fromNumber(this.port),
                        },
                        initialDelaySeconds: 30,
                        periodSeconds: 10,
                        failureThreshold: 3,
                      },
                    }
                  : {}),
              },
            ],
            ...(labels ? { labels } : {}),
          },
        },
      },
    });

    // Create service
    const serviceSpec: any = {
      type: props.serviceType || "ClusterIP",
      ports: [
        {
          name: "http",
          port: this.port,
          targetPort: IntOrString.fromNumber(this.port),
          ...(props.nodePort && props.serviceType === "NodePort"
            ? { nodePort: props.nodePort }
            : {}),
        },
      ],
      selector: { app: id },
    };

    new Service(this, "service", {
      metadata: {
        name: this.serviceName,
        namespace: props.namespace,
        labels,
      },
      spec: serviceSpec,
    });
  }

  /**
   * Get service connection information for other services
   */
  getConnectionInfo(): { host: string; port: number; url: string } {
    return {
      host: this.serviceName,
      port: this.port,
      url: `http://${this.serviceName}:${this.port}`,
    };
  }
}

/**
 * Specialized API Service construct with common API patterns
 */
export class ApiService extends ApplicationService {
  constructor(scope: Construct, id: string, props: ApplicationServiceProps) {
    // Set default health check for APIs
    const config = {
      ...props.config,
      healthCheck: props.config.healthCheck || "/health",
    };

    super(scope, id, {
      ...props,
      config,
      labels: {
        tier: "api",
        ...props.labels,
      },
    });
  }
}

/**
 * Specialized Web Service construct with common frontend patterns
 */
export class WebService extends ApplicationService {
  constructor(scope: Construct, id: string, props: ApplicationServiceProps) {
    // Set default health check for web frontends
    const config = {
      ...props.config,
      healthCheck: props.config.healthCheck || "/",
      port: props.config.port || 80,
    };

    super(scope, id, {
      ...props,
      config,
      labels: {
        tier: "frontend",
        ...props.labels,
      },
    });
  }
}
