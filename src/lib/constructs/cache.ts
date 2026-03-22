/**
 * Cache System Constructs
 * Reusable constructs for Redis, Valkey, and other cache systems
 */

import { Construct } from "constructs";
import { CacheConfig } from "../core/types";
import {
    Deployment,
    IntOrString,
    PersistentVolumeClaim,
    Quantity,
    Service,
} from "../k8s";
import { AppSecret } from "./config";

export interface CacheProps {
  namespace: string;
  appName: string;
  config: CacheConfig;
  labels?: Record<string, string>;
}

/**
 * Base class for cache system constructs
 */
abstract class BaseCache extends Construct {
  public readonly serviceName: string;
  public readonly secret: AppSecret;
  public readonly port: number;

  constructor(scope: Construct, id: string, props: CacheProps, port: number) {
    super(scope, id);

    this.serviceName = `${id}-service`;
    this.port = port;

    const labels = {
      app: id,
      component: "cache",
      "app.kubernetes.io/part-of": props.appName,
      ...props.labels,
    };

    // Create secret for cache credentials
    this.secret = new AppSecret(this, "secret", {
      namespace: props.namespace,
      name: `${id}-secret`,
      data: {
        password: props.config.credentials.password,
      },
      labels,
    });

    // Create PVC for cache persistence (optional for cache systems)
    if (props.config.storageSize && props.config.storageSize !== "0") {
      new PersistentVolumeClaim(this, "pvc", {
        metadata: {
          name: `${id}-pvc`,
          namespace: props.namespace,
          labels,
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          ...(props.config.storageClassName
            ? { storageClassName: props.config.storageClassName }
            : {}),
          resources: {
            requests: {
              storage: Quantity.fromString(props.config.storageSize),
            },
          },
        },
      });
    }

    // Create service
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
            name: "cache",
            port: this.port,
            targetPort: IntOrString.fromNumber(this.port),
          },
        ],
        selector: { app: id },
      },
    });
  }

  /**
   * Get environment references for connecting to this cache
   */
  abstract getConnectionEnv(): Record<string, any>;
}

/**
 * Redis Cache construct
 */
export class RedisCache extends BaseCache {
  private readonly cacheImage: string;

  constructor(scope: Construct, id: string, props: CacheProps) {
    super(scope, id, props, props.config.port || 6379);
    this.cacheImage = props.config.image || "redis:7-alpine";

    const labels = {
      app: id,
      component: "redis",
      "app.kubernetes.io/part-of": props.appName,
      ...props.labels,
    };

    const hasPersistence =
      props.config.storageSize && props.config.storageSize !== "0";

    // Redis Deployment
    new Deployment(this, "deployment", {
      metadata: {
        name: `${id}-deployment`,
        namespace: props.namespace,
        labels,
      },
      spec: {
        replicas: 1, // Cache systems typically run single replica
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
                name: "redis",
                image: props.config.image || "redis:7-alpine",
                ports: [
                  {
                    name: "redis",
                    containerPort: this.port,
                  },
                ],
                env: [
                  {
                    name: "REDIS_PASSWORD",
                    valueFrom: this.secret.envRef("password").valueFrom,
                  },
                ],
                command: hasPersistence
                  ? [
                      "redis-server",
                      "--requirepass",
                      "$(REDIS_PASSWORD)",
                      "--appendonly",
                      "yes",
                      "--dir",
                      "/data",
                    ]
                  : ["redis-server", "--requirepass", "$(REDIS_PASSWORD)"],
                ...(hasPersistence
                  ? {
                      volumeMounts: [
                        {
                          name: "data",
                          mountPath: "/data",
                        },
                      ],
                    }
                  : {}),
                readinessProbe: {
                  exec: {
                    command: ["redis-cli", "-a", "$(REDIS_PASSWORD)", "ping"],
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  exec: {
                    command: ["redis-cli", "-a", "$(REDIS_PASSWORD)", "ping"],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
              },
            ],
            ...(hasPersistence
              ? {
                  volumes: [
                    {
                      name: "data",
                      persistentVolumeClaim: {
                        claimName: `${id}-pvc`,
                      },
                    },
                  ],
                }
              : {}),
          },
        },
      },
    });
  }

  getConnectionEnv(): Record<string, any> {
    return {
      REDIS_HOST: this.serviceName,
      REDIS_PORT: this.port.toString(),
      REDIS_PASSWORD: this.secret.envRef("password"),
      REDIS_URL: {
        value: `redis://:$(REDIS_PASSWORD)@$(REDIS_HOST):$(REDIS_PORT)`,
      },
    };
  }

  /**
   * Init container that polls the cache service until Redis is ready.
   */
  getWaitInitContainer(): Record<string, any> {
    return {
      name: "wait-for-cache",
      image: this.cacheImage,
      command: [
        "/bin/sh",
        "-c",
        'until redis-cli -h "$CACHE_HOST" -p "$CACHE_PORT" -a "$CACHE_PASSWORD" ping 2>/dev/null | grep -q PONG; do echo "Waiting for Redis at $CACHE_HOST..."; sleep 2; done; echo "Cache ready."',
      ],
      env: [
        { name: "CACHE_HOST", value: this.serviceName },
        { name: "CACHE_PORT", value: this.port.toString() },
        {
          name: "CACHE_PASSWORD",
          valueFrom: this.secret.envRef("password").valueFrom,
        },
      ],
    };
  }
}

/**
 * Valkey Cache construct (Redis-compatible)
 */
export class ValkeyCache extends BaseCache {
  private readonly cacheImage: string;

  constructor(scope: Construct, id: string, props: CacheProps) {
    super(scope, id, props, props.config.port || 6379);
    this.cacheImage = props.config.image || "valkey/valkey:7-alpine";

    const labels = {
      app: id,
      component: "valkey",
      "app.kubernetes.io/part-of": props.appName,
      ...props.labels,
    };

    const hasPersistence =
      props.config.storageSize && props.config.storageSize !== "0";

    // Valkey Deployment
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
                name: "valkey",
                image: props.config.image || "valkey/valkey:7-alpine",
                ports: [
                  {
                    name: "valkey",
                    containerPort: this.port,
                  },
                ],
                env: [
                  {
                    name: "VALKEY_PASSWORD",
                    valueFrom: this.secret.envRef("password").valueFrom,
                  },
                ],
                command: hasPersistence
                  ? [
                      "valkey-server",
                      "--requirepass",
                      "$(VALKEY_PASSWORD)",
                      "--appendonly",
                      "yes",
                      "--dir",
                      "/data",
                    ]
                  : ["valkey-server", "--requirepass", "$(VALKEY_PASSWORD)"],
                ...(hasPersistence
                  ? {
                      volumeMounts: [
                        {
                          name: "data",
                          mountPath: "/data",
                        },
                      ],
                    }
                  : {}),
                readinessProbe: {
                  exec: {
                    command: ["valkey-cli", "-a", "$(VALKEY_PASSWORD)", "ping"],
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
                livenessProbe: {
                  exec: {
                    command: ["valkey-cli", "-a", "$(VALKEY_PASSWORD)", "ping"],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
              },
            ],
            ...(hasPersistence
              ? {
                  volumes: [
                    {
                      name: "data",
                      persistentVolumeClaim: {
                        claimName: `${id}-pvc`,
                      },
                    },
                  ],
                }
              : {}),
          },
        },
      },
    });
  }

  getConnectionEnv(): Record<string, any> {
    return {
      VALKEY_HOST: this.serviceName,
      VALKEY_PORT: this.port.toString(),
      VALKEY_PASSWORD: this.secret.envRef("password"),
      VALKEY_URL: {
        value: `redis://:$(VALKEY_PASSWORD)@$(VALKEY_HOST):$(VALKEY_PORT)`,
      },
    };
  }

  /**
   * Init container that polls the cache service until Valkey is ready.
   */
  getWaitInitContainer(): Record<string, any> {
    return {
      name: "wait-for-cache",
      image: this.cacheImage,
      command: [
        "/bin/sh",
        "-c",
        'until valkey-cli -h "$CACHE_HOST" -p "$CACHE_PORT" -a "$CACHE_PASSWORD" ping 2>/dev/null | grep -q PONG; do echo "Waiting for Valkey at $CACHE_HOST..."; sleep 2; done; echo "Cache ready."',
      ],
      env: [
        { name: "CACHE_HOST", value: this.serviceName },
        { name: "CACHE_PORT", value: this.port.toString() },
        {
          name: "CACHE_PASSWORD",
          valueFrom: this.secret.envRef("password").valueFrom,
        },
      ],
    };
  }
}
