/**
 * Database Constructs
 * Reusable constructs for various database systems
 */

import { Construct } from "constructs";
import { DatabaseConfig } from "../core/types";
import {
  Deployment,
  IntOrString,
  PersistentVolumeClaim,
  Quantity,
  Service,
} from "../k8s";
import { PORTS } from "../core/ports";
import { AppSecret } from "./config";
import { appLabels } from "../utils/labels";

export interface DatabaseProps {
  namespace: string;
  appName: string;
  config: DatabaseConfig;
  labels?: Record<string, string>;
}

/**
 * Base class for database constructs with common functionality
 */
abstract class BaseDatabase extends Construct {
  public readonly serviceName: string;
  public readonly secret: AppSecret;
  public readonly port: number;
  protected readonly hasPersistence: boolean;

  constructor(
    scope: Construct,
    id: string,
    props: DatabaseProps,
    port: number,
  ) {
    super(scope, id);

    this.serviceName = `${id}-service`;
    this.port = port;
    this.hasPersistence =
      !!props.config.storageSize && props.config.storageSize !== "0";

    const labels = appLabels(props.appName, "database", {
      app: id,
      ...props.labels,
    });

    // Create secret for database credentials
    this.secret = new AppSecret(this, "secret", {
      namespace: props.namespace,
      name: `${id}-secret`,
      data: {
        database: props.config.credentials.database,
        username: props.config.credentials.username,
        password: props.config.credentials.password,
      },
      labels,
    });

    // Create PVC for data persistence when enabled
    if (this.hasPersistence) {
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
            name: "database",
            port: this.port,
            targetPort: IntOrString.fromNumber(this.port),
          },
        ],
        selector: { app: id },
      },
    });
  }

  /**
   * Get environment references for connecting to this database
   */
  abstract getConnectionEnv(): Record<string, any>;

  /**
   * Get an init container spec that blocks until this database's K8s Service
   * is reachable and accepting real queries. Wire this into any dependent
   * pod's initContainers list to guarantee startup ordering.
   */
  abstract getWaitInitContainer(): Record<string, any>;
}

/**
 * MySQL Database construct
 */
export class MySQLDatabase extends BaseDatabase {
  private readonly dbImage: string;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id, props, props.config.port || PORTS.MYSQL);

    this.dbImage = props.config.image || "mariadb:10.11";

    const labels = appLabels(props.appName, "mysql", {
      app: id,
      ...props.labels,
    });

    const mysqlVolumeMounts = [
      ...(this.hasPersistence
        ? [
            {
              name: "data",
              mountPath: "/var/lib/mysql",
            },
          ]
        : []),
      ...(props.config.initSqlPath
        ? [
            {
              name: "init-sql",
              mountPath: "/docker-entrypoint-initdb.d",
              readOnly: true,
            },
          ]
        : []),
    ];

    const mysqlVolumes = [
      ...(this.hasPersistence
        ? [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: `${id}-pvc`,
              },
            },
          ]
        : []),
      ...(props.config.initSqlPath
        ? [
            {
              name: "init-sql",
              hostPath: {
                path: props.config.initSqlPath,
                type: "Directory",
              },
            },
          ]
        : []),
    ];

    // MySQL Deployment
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
              runAsUser: 999,
              fsGroup: 999,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "mysql",
                image: this.dbImage,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                ports: [
                  {
                    name: "mysql",
                    containerPort: this.port,
                  },
                ],
                env: [
                  {
                    name: "MYSQL_DATABASE",
                    valueFrom: this.secret.envRef("database").valueFrom,
                  },
                  {
                    name: "MYSQL_USER",
                    valueFrom: this.secret.envRef("username").valueFrom,
                  },
                  {
                    name: "MYSQL_PASSWORD",
                    valueFrom: this.secret.envRef("password").valueFrom,
                  },
                  {
                    name: "MYSQL_ROOT_PASSWORD",
                    valueFrom: this.secret.envRef("password").valueFrom,
                  },
                ],
                ...(mysqlVolumeMounts.length > 0
                  ? {
                      volumeMounts: mysqlVolumeMounts,
                    }
                  : {}),
                // Use mariadb-admin ping instead of a TCP check so the pod is
                // only marked Ready once the database engine is fully started
                // and accepting queries — not just when the port opens.
                readinessProbe: {
                  exec: {
                    command: [
                      "/bin/sh",
                      "-c",
                      'mariadb-admin ping -h 127.0.0.1 -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent 2>/dev/null',
                    ],
                  },
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  failureThreshold: 12,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  exec: {
                    command: [
                      "/bin/sh",
                      "-c",
                      'mariadb-admin ping -h 127.0.0.1 -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent 2>/dev/null',
                    ],
                  },
                  initialDelaySeconds: 60,
                  periodSeconds: 15,
                  failureThreshold: 4,
                  timeoutSeconds: 5,
                },
              },
            ],
            ...(mysqlVolumes.length > 0
              ? {
                  volumes: mysqlVolumes,
                }
              : {}),
          },
        },
      },
    });
  }

  getConnectionEnv(): Record<string, any> {
    return {
      MYSQL_HOST: this.serviceName,
      MYSQL_PORT: this.port.toString(),
      MYSQL_DATABASE: this.secret.envRef("database"),
      MYSQL_USER: this.secret.envRef("username"),
      MYSQL_PASSWORD: this.secret.envRef("password"),
      DATABASE_URL: {
        value: `mysql://$(MYSQL_USER):$(MYSQL_PASSWORD)@$(MYSQL_HOST):$(MYSQL_PORT)/$(MYSQL_DATABASE)`,
      },
    };
  }

  /**
   * Init container that polls mysql-service with mariadb-admin until the
   * database is truly ready to accept queries (not just TCP-open).
   */
  getWaitInitContainer(): Record<string, any> {
    return {
      name: "wait-for-mysql",
      image: this.dbImage,
      command: [
        "/bin/sh",
        "-c",
        'until mariadb-admin ping -h "$MYSQL_HOST" -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent 2>/dev/null; do echo "Waiting for MySQL at $MYSQL_HOST..."; sleep 2; done; echo "MySQL ready."',
      ],
      env: [
        { name: "MYSQL_HOST", value: this.serviceName },
        {
          name: "MYSQL_USER",
          valueFrom: this.secret.envRef("username").valueFrom,
        },
        {
          name: "MYSQL_PASSWORD",
          valueFrom: this.secret.envRef("password").valueFrom,
        },
      ],
    };
  }
}

/**
 * MongoDB Database construct
 */
export class MongoDatabase extends BaseDatabase {
  private readonly dbImage: string;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id, props, props.config.port || PORTS.MONGODB);

    this.dbImage = props.config.image || "mongo:7";

    const labels = appLabels(props.appName, "mongodb", {
      app: id,
      ...props.labels,
    });

    // MongoDB Deployment
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
              runAsUser: 999,
              fsGroup: 999,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "mongodb",
                image: this.dbImage,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                ports: [
                  {
                    name: "mongodb",
                    containerPort: this.port,
                  },
                ],
                env: [
                  {
                    name: "MONGO_INITDB_DATABASE",
                    valueFrom: this.secret.envRef("database").valueFrom,
                  },
                  {
                    name: "MONGO_INITDB_ROOT_USERNAME",
                    valueFrom: this.secret.envRef("username").valueFrom,
                  },
                  {
                    name: "MONGO_INITDB_ROOT_PASSWORD",
                    valueFrom: this.secret.envRef("password").valueFrom,
                  },
                ],
                ...(this.hasPersistence
                  ? {
                      volumeMounts: [
                        {
                          name: "data",
                          mountPath: "/data/db",
                        },
                      ],
                    }
                  : {}),
                // Use mongosh ping instead of TCP check so the pod is only
                // marked Ready after MongoDB has finished initializing auth.
                readinessProbe: {
                  exec: {
                    command: [
                      "/bin/sh",
                      "-c",
                      'mongosh --host 127.0.0.1 --port "${MONGO_PORT:-27017}" -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand(\'ping\')" --quiet 2>/dev/null',
                    ],
                  },
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  failureThreshold: 12,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  exec: {
                    command: [
                      "/bin/sh",
                      "-c",
                      'mongosh --host 127.0.0.1 --port "${MONGO_PORT:-27017}" -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand(\'ping\')" --quiet 2>/dev/null',
                    ],
                  },
                  initialDelaySeconds: 60,
                  periodSeconds: 15,
                  failureThreshold: 4,
                  timeoutSeconds: 10,
                },
              },
            ],
            ...(this.hasPersistence
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
      MONGODB_HOST: this.serviceName,
      MONGODB_PORT: this.port.toString(),
      MONGODB_DATABASE: this.secret.envRef("database"),
      MONGODB_USERNAME: this.secret.envRef("username"),
      MONGODB_PASSWORD: this.secret.envRef("password"),
      MONGODB_URL: {
        value: `mongodb://$(MONGODB_USERNAME):$(MONGODB_PASSWORD)@$(MONGODB_HOST):$(MONGODB_PORT)/$(MONGODB_DATABASE)`,
      },
    };
  }

  /**
   * Init container that polls mongo-service with mongosh until MongoDB is
   * fully initialized and accepting authenticated queries.
   */
  getWaitInitContainer(): Record<string, any> {
    return {
      name: "wait-for-mongo",
      image: this.dbImage,
      command: [
        "/bin/sh",
        "-c",
        'until mongosh --host "$MONGODB_HOST" --port "$MONGODB_PORT" -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand(\'ping\')" --quiet 2>/dev/null; do echo "Waiting for MongoDB at $MONGODB_HOST..."; sleep 2; done; echo "MongoDB ready."',
      ],
      env: [
        { name: "MONGODB_HOST", value: this.serviceName },
        { name: "MONGODB_PORT", value: this.port.toString() },
        {
          name: "MONGO_INITDB_ROOT_USERNAME",
          valueFrom: this.secret.envRef("username").valueFrom,
        },
        {
          name: "MONGO_INITDB_ROOT_PASSWORD",
          valueFrom: this.secret.envRef("password").valueFrom,
        },
      ],
    };
  }
}
