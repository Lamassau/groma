import { Construct } from "constructs";
import { ServiceConfig } from "../core/types";
import { Deployment, IntOrString, Quantity, Service } from "../k8s";
import { appLabels } from "../utils/labels";

export interface ApplicationServiceProps {
  namespace: string;
  appName: string;
  config: ServiceConfig;
  command?: string[];
  env?: Record<string, any>;
  envFrom?: Array<{
    configMapRef?: { name: string };
    secretRef?: { name: string };
  }>;
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  labels?: Record<string, string>;
  nodePort?: number;
  initContainers?: any[];
}

const POD_SECURITY_CONTEXT = {
  runAsNonRoot: true,
  runAsUser: 1000,
  fsGroup: 2000,
  seccompProfile: { type: "RuntimeDefault" },
};

const CONTAINER_SECURITY_CONTEXT = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};

/**
 * Generic application service construct.
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

    const component = props.labels?.tier ?? "application";
    const baseLabels = appLabels(props.appName, component, {
      app: id,
      ...props.labels,
    });
    const selectorLabels = { app: id };

    // Build environment variables array
    const envVars: Array<{ name: string; value?: string; valueFrom?: any }> =
      [];
    const addedKeys = new Set<string>();

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

    if (props.config.env) {
      Object.entries(props.config.env).forEach(([key, value]) => {
        if (!addedKeys.has(key)) {
          envVars.push({ name: key, value });
        }
      });
    }

    const healthCheckPath = props.config.healthCheck;
    const replicas = props.config.replicas;

    new Deployment(this, "deployment", {
      metadata: {
        name: this.deploymentName,
        namespace: props.namespace,
        labels: baseLabels,
      },
      spec: {
        replicas,
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels: { ...selectorLabels, ...baseLabels } },
          spec: {
            securityContext: POD_SECURITY_CONTEXT,
            terminationGracePeriodSeconds: 30,
            ...(props.initContainers && props.initContainers.length > 0
              ? { initContainers: props.initContainers }
              : {}),
            ...(replicas > 1
              ? {
                  topologySpreadConstraints: [
                    {
                      maxSkew: 1,
                      topologyKey: "kubernetes.io/hostname",
                      whenUnsatisfiable: "DoNotSchedule",
                      labelSelector: { matchLabels: selectorLabels },
                    },
                  ],
                }
              : {}),
            containers: [
              {
                name: id,
                image: props.config.image,
                imagePullPolicy:
                  props.config.imagePullPolicy ?? "IfNotPresent",
                securityContext: CONTAINER_SECURITY_CONTEXT,
                lifecycle: {
                  preStop: {
                    exec: { command: ["/bin/sh", "-c", "sleep 5"] },
                  },
                },
                ...(props.command && props.command.length > 0
                  ? { command: props.command }
                  : {}),
                ports: [{ name: "http", containerPort: this.port }],
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
                ...(healthCheckPath
                  ? {
                      startupProbe: {
                        httpGet: {
                          path: healthCheckPath,
                          port: IntOrString.fromNumber(this.port),
                        },
                        initialDelaySeconds: 5,
                        periodSeconds: 10,
                        failureThreshold: 30,
                      },
                      readinessProbe: {
                        httpGet: {
                          path: healthCheckPath.replace(/\/?$/, "/ready"),
                          port: IntOrString.fromNumber(this.port),
                        },
                        initialDelaySeconds: 10,
                        periodSeconds: 5,
                        failureThreshold: 3,
                      },
                      livenessProbe: {
                        httpGet: {
                          path: healthCheckPath.replace(/\/?$/, "/live"),
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
          },
        },
      },
    });

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
      selector: selectorLabels,
    };

    new Service(this, "service", {
      metadata: {
        name: this.serviceName,
        namespace: props.namespace,
        labels: baseLabels,
      },
      spec: serviceSpec,
    });
  }

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
    super(scope, id, {
      ...props,
      config: {
        ...props.config,
        healthCheck: props.config.healthCheck || "/health",
      },
      labels: { tier: "api", ...props.labels },
    });
  }
}

/**
 * Specialized Web Service construct with common frontend patterns
 */
export class WebService extends ApplicationService {
  constructor(scope: Construct, id: string, props: ApplicationServiceProps) {
    super(scope, id, {
      ...props,
      config: {
        ...props.config,
        healthCheck: props.config.healthCheck || "/",
        port: props.config.port || 80,
      },
      labels: { tier: "frontend", ...props.labels },
    });
  }
}
