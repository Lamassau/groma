import { ApiObject, Chart, ChartProps } from "cdk8s";
import { Construct } from "constructs";
import {
  ApiService,
  ApplicationService,
  AppConfigMap,
  AppSecret,
  AppHpa,
  AppPdb,
  DatabaseAdmin,
  MariaDbBackup,
  MongoDatabase,
  MySQLDatabase,
  NamespaceNetworkPolicies,
  RedisCache,
  ValkeyCache,
  WebService,
} from "../constructs";
import { PORTS } from "../core/ports";
import { FullStackConfig } from "../core/types";
import { Ingress, LimitRange, Namespace, Quantity, ResourceQuota } from "../k8s";

/**
 * Full-stack sample chart demonstrating the complete pattern.
 *
 * Deploys:
 *   1. Namespace
 *   2. AppConfig (non-secret env vars)
 *   3. SecretStore (app-level secrets like JWT, API keys)
 *   4. MySQL database  (with credentials Secret + PVC)
 *   5. MongoDB          (with credentials Secret + PVC)
 *   6. Valkey (Redis)   (with credentials Secret + PVC)
 *   7. API service      (connected to all datastores)
 *   8. Web service      (frontend)
 *   9. WhoDB            (dev-only DB management UI)
 *
 * Every WebService gets its config injected via envFrom,
 * so the same chart works across local → dev → staging → prod
 * by simply changing the EnvConfig.
 *
 * Copy this chart and strip out the parts you don't need.
 */

export interface FullStackChartProps extends ChartProps {
  config: FullStackConfig;
}

export class FullStackChart extends Chart {
  constructor(scope: Construct, id: string, props: FullStackChartProps) {
    super(scope, id, props);

    const cfg = props.config;
    const ns = cfg.namespace;

    // ── 1. Namespace (with Pod Security Standards) ──
    new Namespace(this, "ns", {
      metadata: {
        name: ns,
        labels: {
          "pod-security.kubernetes.io/enforce":
            cfg.environment === "prod" ? "restricted" : "baseline",
          "pod-security.kubernetes.io/warn": "restricted",
        },
      },
    });

    // ── 1a. LimitRange — safety net for containers missing resource specs ──
    new LimitRange(this, "default-limits", {
      metadata: { name: "default-limits", namespace: ns },
      spec: {
        limits: [
          {
            type: "Container",
            default: {
              cpu: Quantity.fromString("500m"),
              memory: Quantity.fromString("512Mi"),
            },
            defaultRequest: {
              cpu: Quantity.fromString("100m"),
              memory: Quantity.fromString("128Mi"),
            },
          },
        ],
      },
    });

    // ── 1b. ResourceQuota — prevent runaway consumption in shared clusters ──
    new ResourceQuota(this, "quota", {
      metadata: { name: "resource-quota", namespace: ns },
      spec: {
        hard: {
          "requests.cpu": Quantity.fromString(
            cfg.environment === "prod" ? "8" : "4",
          ),
          "requests.memory": Quantity.fromString(
            cfg.environment === "prod" ? "16Gi" : "8Gi",
          ),
          "limits.cpu": Quantity.fromString(
            cfg.environment === "prod" ? "16" : "8",
          ),
          "limits.memory": Quantity.fromString(
            cfg.environment === "prod" ? "32Gi" : "16Gi",
          ),
          persistentvolumeclaims: Quantity.fromString("10"),
        },
      },
    });

    // ── 2. App Config (non-secret) ──
    const appConfig = new AppConfigMap(this, "app-config", {
      namespace: ns,
      name: "app-config",
      data: cfg.appConfig,
    });

    // ── 3. App Secrets (API keys, JWT, etc.) ──
    const appSecrets = new AppSecret(this, "app-secrets", {
      namespace: ns,
      name: "app-secrets",
      data: cfg.appSecrets,
      ...(cfg.secretsBackend === "external-secrets" && cfg.externalSecretStore
        ? {
            externalSecretRef: {
              storeName: cfg.externalSecretStore.name,
              storeKind: cfg.externalSecretStore.kind,
              remoteKeyPrefix: cfg.externalSecretStore.remoteKeyPrefix,
              refreshInterval: cfg.externalSecretStore.refreshInterval,
            },
          }
        : {}),
    });

    // ── 4-6. Datastores ──
    const mysqlConfig = cfg.database.mysql;
    const mongoConfig = cfg.nosql.mongodb;
    const valkeyConfig = cfg.cache.valkey;
    const redisConfig = cfg.cache.redis;

    const mysql =
      mysqlConfig && mysqlConfig.enabled
        ? new MySQLDatabase(this, "mysql", {
            namespace: ns,
            appName: cfg.appName,
            config: mysqlConfig,
          })
        : undefined;

    const mongo =
      mongoConfig && mongoConfig.enabled
        ? new MongoDatabase(this, "mongo", {
            namespace: ns,
            appName: cfg.appName,
            config: mongoConfig,
          })
        : undefined;

    const cache = valkeyConfig?.enabled
      ? new ValkeyCache(this, "cache", {
          namespace: ns,
          appName: cfg.appName,
          config: valkeyConfig,
        })
      : redisConfig?.enabled
        ? new RedisCache(this, "cache", {
            namespace: ns,
            appName: cfg.appName,
            config: redisConfig,
          })
        : undefined;

    const apiConnectionEnv = {
      ...(mysql ? mysql.getConnectionEnv() : {}),
      ...(mongo ? mongo.getConnectionEnv() : {}),
      ...(cache ? cache.getConnectionEnv() : {}),
    };

    // Build init containers so the API pod only starts after every datastore
    // it depends on is truly ready (not just TCP-open).
    const apiInitContainers = [
      ...(mysql ? [mysql.getWaitInitContainer()] : []),
      ...(mongo ? [mongo.getWaitInitContainer()] : []),
      ...(cache ? [cache.getWaitInitContainer()] : []),
    ];

    // ── 7. API Service ──
    new ApiService(this, "api", {
      namespace: ns,
      appName: cfg.appName,
      config: cfg.services.api,
      command: cfg.services.api.command,
      envFrom: [appConfig.envFromRef(), appSecrets.envFromRef()],
      env: apiConnectionEnv,
      serviceType: cfg.services.api.serviceType,
      nodePort: cfg.services.api.nodePort,
      initContainers:
        apiInitContainers.length > 0 ? apiInitContainers : undefined,
    });

    // ── 8. Web (Frontend) Service ──
    new WebService(this, "web", {
      namespace: ns,
      appName: cfg.appName,
      config: cfg.services.web,
      command: cfg.services.web.command,
      envFrom: [appConfig.envFromRef()],
      env: cfg.services.web.env ?? {},
      serviceType: cfg.services.web.serviceType,
      nodePort: cfg.services.web.nodePort,
    });

    // ── 8b. Additional services (worker, scheduler, etc.) ──
    for (const [svcName, svcCfg] of Object.entries(cfg.services)) {
      if (svcName === "api" || svcName === "web") continue;
      new ApplicationService(this, svcName, {
        namespace: ns,
        appName: cfg.appName,
        config: svcCfg,
        command: svcCfg.command,
        envFrom: [appConfig.envFromRef(), appSecrets.envFromRef()],
        env: {
          ...apiConnectionEnv,
          ...(svcCfg.env ?? {}),
        },
        serviceType: svcCfg.serviceType,
        nodePort: svcCfg.nodePort,
      });
    }

    new Ingress(this, "api-ingress", {
      metadata: {
        name: `${cfg.appName}-api`,
        namespace: ns,
        annotations: {
          ...cfg.ingress.annotations,
        },
      },
      spec: {
        ingressClassName: cfg.ingress.className,
        ...(cfg.ingress.tls
          ? {
              tls: [
                {
                  secretName: cfg.ingress.tls.secretName,
                  hosts: cfg.ingress.tls.hosts.length > 0
                    ? cfg.ingress.tls.hosts
                    : [`api.${cfg.domain}`],
                },
              ],
            }
          : {}),
        rules: [
          {
            host: `api.${cfg.domain}`,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "api-service",
                      port: {
                        number: cfg.services.api.port,
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    new Ingress(this, "web-ingress", {
      metadata: {
        name: `${cfg.appName}-web`,
        namespace: ns,
        annotations: {
          ...cfg.ingress.annotations,
        },
      },
      spec: {
        ingressClassName: cfg.ingress.className,
        ...(cfg.ingress.tls
          ? {
              tls: [
                {
                  secretName: cfg.ingress.tls.secretName,
                  hosts: cfg.ingress.tls.hosts.length > 0
                    ? cfg.ingress.tls.hosts
                    : [`web.${cfg.domain}`],
                },
              ],
            }
          : {}),
        rules: [
          {
            host: `web.${cfg.domain}`,
            http: {
              paths: [
                {
                  path: "/api",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "api-service",
                      port: {
                        number: cfg.services.api.port,
                      },
                    },
                  },
                },
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "web-service",
                      port: {
                        number: cfg.services.web.port,
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    // Derive Traefik entryPoints from the router annotation value (comma-separated)
    const traefikEntryPoints = (
      cfg.ingress.annotations?.[
        "traefik.ingress.kubernetes.io/router.entrypoints"
      ] ?? "web"
    )
      .split(",")
      .map((s) => s.trim());

    new ApiObject(this, "api-ingress-route", {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: `${cfg.appName}-api-route`,
        namespace: ns,
      },
      spec: {
        entryPoints: traefikEntryPoints,
        routes: [
          {
            kind: "Rule",
            match: `Host(\`api.${cfg.domain}\`)`,
            services: [
              {
                name: "api-service",
                port: cfg.services.api.port,
              },
            ],
          },
        ],
      },
    });

    new ApiObject(this, "web-ingress-route", {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: `${cfg.appName}-web-route`,
        namespace: ns,
      },
      spec: {
        entryPoints: traefikEntryPoints,
        routes: [
          {
            kind: "Rule",
            match: `Host(\`web.${cfg.domain}\`) && PathPrefix(\`/api\`)`,
            services: [
              {
                name: "api-service",
                port: cfg.services.api.port,
              },
            ],
          },
          {
            kind: "Rule",
            match: `Host(\`web.${cfg.domain}\`)`,
            services: [
              {
                name: "web-service",
                port: cfg.services.web.port,
              },
            ],
          },
        ],
      },
    });

    // ── 9. NetworkPolicies (default-deny + explicit allow per service) ──
    new NamespaceNetworkPolicies(this, "netpol", {
      namespace: ns,
      appName: cfg.appName,
      apiPort: cfg.services.api.port,
      webPort: cfg.services.web.port,
      mysqlPort: PORTS.MYSQL,
      mongoPort: PORTS.MONGODB,
      cachePort: PORTS.REDIS,
    });

    // ── 10. Horizontal Pod Autoscaler (staging + production) ──
    if (cfg.environment === "staging" || cfg.environment === "prod") {
      const apiReplicas = cfg.services.api.replicas;
      new AppHpa(this, "api-hpa", {
        namespace: ns,
        deploymentName: "api-deployment",
        minReplicas: apiReplicas,
        maxReplicas: apiReplicas * 3,
        targetCpuUtilizationPercentage: 70,
      });

      new AppHpa(this, "web-hpa", {
        namespace: ns,
        deploymentName: "web-deployment",
        minReplicas: cfg.services.web.replicas,
        maxReplicas: cfg.services.web.replicas * 2,
        targetCpuUtilizationPercentage: 80,
      });
    }

    // ── 11. PodDisruptionBudgets (staging + production) ──
    if (cfg.environment === "staging" || cfg.environment === "prod") {
      new AppPdb(this, "api-pdb", {
        namespace: ns,
        selectorKey: "app",
        selectorValue: "api",
        replicas: cfg.services.api.replicas,
        maxUnavailable: 1,
      });

      new AppPdb(this, "web-pdb", {
        namespace: ns,
        selectorKey: "app",
        selectorValue: "web",
        replicas: cfg.services.web.replicas,
        maxUnavailable: 1,
      });
    }

    // ── 13. Automated database backups (staging + production) ──
    // Daily mysqldump → gzip → S3 upload with 30-day retention.
    // Requires a Kubernetes Secret named "<appName>-s3-credentials" with:
    //   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
    if (
      (cfg.environment === "staging" || cfg.environment === "prod") &&
      mysqlConfig?.enabled &&
      mysql
    ) {
      new MariaDbBackup(this, "db-backup", {
        namespace: ns,
        appName: cfg.appName,
        mysqlHost: mysql.serviceName,
        credentialsSecretName: "mysql-secret",
        s3Bucket: `${cfg.appName}-backups-${cfg.environment}`,
        s3CredentialsSecretName: `${cfg.appName}-s3-credentials`,
        retentionDays: 30,
        // Run at 02:00 UTC daily
        schedule: "0 2 * * *",
      });
    }

    // ── 14. Development tools ──
    if (cfg.devTools.dbAdmin.enabled && cfg.environment !== "prod") {
      new DatabaseAdmin(this, "whodb", {
        namespace: ns,
        appName: cfg.appName,
        config: cfg.devTools,
        databases: [
          ...(mysql
            ? [
                {
                  type: "mysql" as const,
                  host: mysql.serviceName,
                  port: mysql.port,
                  username: mysqlConfig?.credentials.username,
                  password: mysqlConfig?.credentials.password,
                  database: mysqlConfig?.credentials.database,
                },
              ]
            : []),
          ...(mongo
            ? [
                {
                  type: "mongodb" as const,
                  host: mongo.serviceName,
                  port: mongo.port,
                  username: mongoConfig?.credentials.username,
                  password: mongoConfig?.credentials.password,
                  database: mongoConfig?.credentials.database,
                },
              ]
            : []),
          ...(cache
            ? [
                {
                  type: (valkeyConfig?.enabled ? "valkey" : "redis") as
                    | "valkey"
                    | "redis",
                  host: cache.serviceName,
                  port: cache.port,
                  password:
                    valkeyConfig?.credentials.password ??
                    redisConfig?.credentials.password,
                },
              ]
            : []),
        ],
      });
    }
  }
}
