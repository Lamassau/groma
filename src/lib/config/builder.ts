import { randomBytes } from "crypto";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";
import { getConfigDir, getResourcesDir, PATHS } from "../../devenv-config";
import {
  DevToolsConfig,
  Environment,
  FullStackConfig,
  ServiceConfig,
} from "../core/types";
import { DevEnvConfig } from "./devenv-types";
import {
  CommonConfig,
  EnvAppConfig,
  EnvResourceConfig,
  MergedInfraConfig,
} from "./infra-config-types";

/**
 * Load devenv.yaml configuration from file system
 */
export function loadDevEnvConfig(configPath?: string): DevEnvConfig {
  const defaultPath = PATHS.DEVENV_YAML;
  const resolvedPath = configPath || defaultPath;

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`DevEnv config file not found at: ${resolvedPath}`);
  }

  const fileContent = fs.readFileSync(resolvedPath, "utf8");
  return yaml.load(fileContent) as DevEnvConfig;
}

/**
 * Parse a .env file and convert flattened keys to nested object structure.
 * Keys are flattened using double underscores (__).
 * Example: APP_CONFIG__NODE_ENV=production → { appConfig: { NODE_ENV: "production" } }
 */
function parseEnvFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};

  const content = fs.readFileSync(filePath, "utf8");
  const result: Record<string, any> = {};

  // Parse each line
  const lines = content.split("\n");
  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Parse KEY=VALUE
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    let value = match[2].trim();

    // Remove quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Convert flattened key to nested structure
    const parts = key.split("__");
    let current = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = convertKeyToCamelCase(parts[i]);
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];
    // For certain keys, preserve the original case (like env vars)
    const finalKey = shouldPreserveCase(parts)
      ? lastPart
      : convertKeyToCamelCase(lastPart);

    // Handle comma-separated arrays (for commands)
    if (value.includes(",") && lastPart.toLowerCase() === "command") {
      current[finalKey] = value.split(",").map((v) => v.trim());
    } else {
      current[finalKey] = value;
    }
  }

  return result;
}

/**
 * Convert SCREAMING_SNAKE_CASE to camelCase for nested object keys
 * Examples:
 *   - APP_CONFIG → appConfig
 *   - DB_ADMIN → dbAdmin
 *   - SERVICES → services
 *   - TARGET_PORT → targetPort
 */
function convertKeyToCamelCase(key: string): string {
  // Convert SNAKE_CASE to camelCase: lowercase first, then capitalize after underscores
  return key
    .toLowerCase()
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Check if the key path should preserve its case (e.g., environment variables)
 */
function shouldPreserveCase(parts: string[]): boolean {
  // Preserve case for appConfig and appSecrets values
  return (
    parts.length >= 2 &&
    (parts[0] === "APP_CONFIG" ||
      parts[0] === "APP_SECRETS" ||
      parts[parts.length - 2] === "ENV")
  );
}

/**
 * Load a .env file and return its parsed contents as a typed object,
 * or an empty object if the file doesn't exist.
 */
function loadEnvOptional<T>(filePath: string): T {
  const parsed = parseEnvFile(filePath);
  return parsed as T;
}

/**
 * Load a YAML file and return its parsed contents, or an empty object if the
 * file doesn't exist (so missing optional files are silently skipped).
 */
function loadYamlOptional<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) return {} as T;
  return yaml.load(fs.readFileSync(filePath, "utf8")) as T;
}

/**
 * Assert that a config value is present; throw a descriptive error if not.
 */
function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null) {
    throw new Error(
      `Missing required config value: "${field}". ` +
        `Add it to the appropriate .env or YAML config file.`,
    );
  }
  return value;
}

/**
 * Load and merge the three config layers for a given environment:
 *   1. config/common.env
 *   2. config/{env}/.env
 *   3. .infra/resources/{env}.yaml (still YAML for complex resource definitions)
 *
 * @param env         Environment name (e.g. "local", "staging", "prod")
 * @param configDir   Absolute path to the config/ directory.
 *                    Defaults to .devenv/config/ (via devenv-config.ts).
 *                    Can also be overridden via INFRA_CONFIG_DIR environment variable.
 */
export function loadInfraConfig(
  env: string,
  configDir?: string,
): MergedInfraConfig {
  const dir = configDir ?? getConfigDir();
  const resourcesDir = getResourcesDir();

  return {
    common: loadEnvOptional<CommonConfig>(path.join(dir, "common.env")),
    app: loadEnvOptional<EnvAppConfig>(path.join(dir, `${env}/.env`)),
    resources: loadYamlOptional<EnvResourceConfig>(
      path.join(resourcesDir, `${env}.yaml`),
    ),
  };
}

/**
 * Generate a cryptographically-secure random password.
 *
 * For local/dev this is called at synth time and embedded in the manifest.
 * For staging/prod credentials MUST come from a secrets manager (External
 * Secrets Operator, Vault, AWS Secrets Manager) — never from this function.
 */
export function generatePassword(length = 24): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

/**
 * Assert that a CPU string is non-zero/non-empty so resource validation
 * catches misconfigured manifests before they reach the cluster.
 */
function assertPositiveCpu(val: string | undefined, ctx: string): void {
  if (!val || val === "0" || val === "0m") {
    throw new Error(`${ctx}: cpu must be a non-zero value (e.g. "100m", "0.5")`);
  }
}

/**
 * Assert that a memory string is non-zero/non-empty.
 */
function assertPositiveMemory(val: string | undefined, ctx: string): void {
  if (!val || val === "0") {
    throw new Error(`${ctx}: memory must be a non-zero value (e.g. "128Mi", "1Gi")`);
  }
}

/**
 * Validate that resource limits/requests are sane before synthesis.
 */
function validateResources(
  resources: { limits?: { cpu: string; memory: string }; requests?: { cpu: string; memory: string } } | undefined,
  ctx: string,
): void {
  if (!resources) throw new Error(`${ctx}: resources block is required`);
  if (resources.limits) {
    assertPositiveCpu(resources.limits.cpu, `${ctx}.limits.cpu`);
    assertPositiveMemory(resources.limits.memory, `${ctx}.limits.memory`);
  }
  if (resources.requests) {
    assertPositiveCpu(resources.requests.cpu, `${ctx}.requests.cpu`);
    assertPositiveMemory(resources.requests.memory, `${ctx}.requests.memory`);
  }
}

/**
 * Build environment-specific configuration from devenv config.
 * Values are resolved in priority order (highest → lowest):
 *   1. config/env/resources/{env}.yaml  (infra sizing)
 *   2. config/env/{env}.env             (app config)
 *   3. config/common.env                (shared defaults)
 *
 * Missing required values throw an error — no silent fallbacks.
 */
export function buildFullStackConfig(
  devEnvConfig: DevEnvConfig,
  appName: string,
  options: {
    apiImage?: string;
    webImage?: string;
    enableMongoDB?: boolean;
    enableRedis?: boolean;
    configDir?: string;
    /** Names of additional services to load (e.g. ["worker", "scheduler"]).
     *  Each must have a matching services.{name} entry in config/{env}/.env and
     *  optionally resources in resources/{env}.yaml. */
    additionalServices?: string[];
  } = {},
): FullStackConfig {
  const env = (process.env.APP_ENV || "local") as Environment;
  const registry = devEnvConfig.podman.registry;
  const version = "local";
  const configuredAppName = devEnvConfig.app?.name || appName;
  const configuredDomain = (
    devEnvConfig.app?.domain ||
    devEnvConfig.cluster.domain ||
    `${configuredAppName}.local`
  ).replace(/\$\{app\.name\}/g, configuredAppName);

  // Simple image naming: {registry}/{appName}-{serviceName}:{version}
  // E.g., registry.gitlab.com/lamassau/registry/futbalio-web:local
  // E.g., registry.gitlab.com/lamassau/registry/futbalio-api:local
  const apiImage =
    options.apiImage || `${registry}/${configuredAppName}-api:${version}`;
  const webImage =
    options.webImage || `${registry}/${configuredAppName}-web:${version}`;

  // ── Load the three config layers ──────────────────────────────────────────────────
  const infraConfig = loadInfraConfig(env, options.configDir);
  const { common, app: envApp, resources: envRes } = infraConfig;

  const svcApp = (name: string) => envApp.services?.[name] ?? {};
  const svcRes = (name: string) => envRes.services?.[name] ?? {};
  const dbApp = (name: string) => envApp.databases?.[name] ?? {};
  const dbRes = (name: string) => envRes.databases?.[name] ?? {};

  const namespace = envApp.namespace ?? `${configuredAppName}-${env}`;
  const domain = envApp.domain ?? configuredDomain;

  // ── App-wide config / secrets (must be in env yaml) ───────────────────────────
  const appConfig = required(envApp.appConfig, "appConfig");
  const appSecrets = required(envApp.appSecrets, "appSecrets");

  // ── Service config (must be in env yaml) ───────────────────────────────────
  const apiReplicas = required(svcApp("api").replicas, "services.api.replicas");
  const webReplicas = required(svcApp("web").replicas, "services.web.replicas");
  const apiCommand = required(svcApp("api").command, "services.api.command");
  const webCommand = required(svcApp("web").command, "services.web.command");

  // ── Resources (must be in resources yaml) ──────────────────────────────────
  const apiResources = required(
    svcRes("api").resources,
    "services.api.resources (in resources yaml)",
  );
  const webResources = required(
    svcRes("web").resources,
    "services.web.resources (in resources yaml)",
  );

  // ── Storage sizes (must be in resources yaml) ─────────────────────────────
  const mysqlStorage = required(
    dbRes("mysql").storageSize,
    "databases.mysql.storageSize (in resources yaml)",
  );
  const mongoStorage = required(
    dbRes("mongodb").storageSize,
    "databases.mongodb.storageSize (in resources yaml)",
  );
  const redisStorage = required(
    dbRes("redis").storageSize,
    "databases.redis.storageSize (in resources yaml)",
  );

  // ── Validate resources (fail fast before synthesis reaches constructs) ────
  validateResources(apiResources, "services.api.resources");
  validateResources(webResources, "services.web.resources");

  // ── Database credentials (must be in env yaml) ─────────────────────────────
  const mysqlCreds = {
    database: required(
      dbApp("mysql").credentials?.database,
      "databases.mysql.credentials.database",
    ),
    username: required(
      dbApp("mysql").credentials?.username,
      "databases.mysql.credentials.username",
    ),
    password: required(
      dbApp("mysql").credentials?.password,
      "databases.mysql.credentials.password",
    ),
  };
  const mysqlInitSqlPathRaw =
    dbApp("mysql").initSqlPath ?? common.databases?.["mysql"]?.initSqlPath;
  const mysqlInitSqlPath = mysqlInitSqlPathRaw
    ? path.resolve(process.cwd(), mysqlInitSqlPathRaw)
    : undefined;
  const mongoCreds = {
    database: required(
      dbApp("mongodb").credentials?.database,
      "databases.mongodb.credentials.database",
    ),
    username: required(
      dbApp("mongodb").credentials?.username,
      "databases.mongodb.credentials.username",
    ),
    password: required(
      dbApp("mongodb").credentials?.password,
      "databases.mongodb.credentials.password",
    ),
  };
  const redisCreds = {
    password: required(
      dbApp("redis").credentials?.password,
      "databases.redis.credentials.password",
    ),
  };

  // ── devTools (must be in env yaml) ─────────────────────────────────────────────
  const dbAdminEnabled = required(
    envApp.devtools?.dbAdmin?.enabled,
    "devtools.dbAdmin.enabled",
  );
  const dbAdminPort = required(
    envApp.devtools?.dbAdmin?.port,
    "devtools.dbAdmin.port",
  );

  // ── Ingress (must be in env yaml) ──────────────────────────────────────────
  const ingressEnabled = required(envApp.ingress?.enabled, "ingress.enabled");
  const ingressClassName = required(
    envApp.ingress?.className,
    "ingress.className",
  );
  const ingressAnnotations = envApp.ingress?.annotations ?? {};

  // ── Secrets backend ────────────────────────────────────────────────────────
  const secretsBackend = envApp.secretsBackend ?? "inline";
  const externalSecretStore = envApp.externalSecretStore;

  // ── Build FullStackConfig ──────────────────────────────────────────────────────
  const config: FullStackConfig = {
    environment: env,
    namespace,
    domain,
    appName: configuredAppName,
    appConfig,
    appSecrets,
    secretsBackend,
    ...(externalSecretStore ? { externalSecretStore } : {}),

    database: {
      mysql: {
        enabled: required(dbApp("mysql").enabled, "databases.mysql.enabled"),
        credentials: mysqlCreds,
        storageSize: mysqlStorage,
        initSqlPath: mysqlInitSqlPath,
        storageClassName: dbApp("mysql").storageClassName,
        image: common.databases?.["mysql"]?.image,
        port: common.databases?.["mysql"]?.port,
      },
    },

    nosql: {
      mongodb: options.enableMongoDB
        ? {
            enabled: required(
              dbApp("mongodb").enabled,
              "databases.mongodb.enabled",
            ),
            credentials: mongoCreds,
            storageSize: mongoStorage,
            storageClassName: dbApp("mongodb").storageClassName,
            image: common.databases?.["mongodb"]?.image,
            port: common.databases?.["mongodb"]?.port,
          }
        : {
            enabled: false,
            credentials: { database: "", username: "", password: "" },
            storageSize: "",
          },
    },

    cache: {
      redis: options.enableRedis
        ? {
            enabled: required(
              dbApp("redis").enabled,
              "databases.redis.enabled",
            ),
            credentials: redisCreds,
            storageSize: redisStorage,
            storageClassName: dbApp("redis").storageClassName,
            image: common.databases?.["redis"]?.image,
            port: common.databases?.["redis"]?.port,
          }
        : { enabled: false, credentials: { password: "" }, storageSize: "" },
    },

    services: {
      api: {
        image: apiImage,
        replicas: apiReplicas,
        port: common.services?.["api"]?.port ?? 3000,
        command: apiCommand,
        resources: apiResources,
        env: svcApp("api").env,
        healthCheck:
          svcApp("api").healthCheck ??
          common.services?.["api"]?.healthCheck ??
          "/api/health",
        serviceType: svcApp("api").serviceType as ServiceConfig["serviceType"],
        nodePort: svcApp("api").nodePort,
        imagePullPolicy: svcApp("api")
          .imagePullPolicy as ServiceConfig["imagePullPolicy"],
        debugPort: svcApp("api").debugPort,
        debugNodePort: svcApp("api").debugNodePort,
      },
      web: {
        image: webImage,
        replicas: webReplicas,
        port: common.services?.["web"]?.port ?? 4200,
        command: webCommand,
        resources: webResources,
        env: svcApp("web").env,
        healthCheck:
          svcApp("web").healthCheck ??
          common.services?.["web"]?.healthCheck ??
          "/",
        serviceType: svcApp("web").serviceType as ServiceConfig["serviceType"],
        nodePort: svcApp("web").nodePort,
        imagePullPolicy: svcApp("web")
          .imagePullPolicy as ServiceConfig["imagePullPolicy"],
      },
      ...Object.fromEntries(
        (options.additionalServices ?? []).map((svcName) => {
          const svcCfg = svcApp(svcName);
          const svcResCfg = svcRes(svcName);
          return [
            svcName,
            {
              image: `${registry}/${configuredAppName}-${svcName}:${version}`,
              replicas: required(
                svcCfg.replicas,
                `services.${svcName}.replicas`,
              ),
              port: common.services?.[svcName]?.port ?? 3000,
              command: required(svcCfg.command, `services.${svcName}.command`),
              resources: svcResCfg.resources,
              env: svcCfg.env,
              healthCheck:
                svcCfg.healthCheck ??
                common.services?.[svcName]?.healthCheck ??
                "/health",
              serviceType: svcCfg.serviceType as ServiceConfig["serviceType"],
              nodePort: svcCfg.nodePort,
              imagePullPolicy:
                svcCfg.imagePullPolicy as ServiceConfig["imagePullPolicy"],
              debugPort: svcCfg.debugPort,
              debugNodePort: svcCfg.debugNodePort,
            } satisfies ServiceConfig,
          ];
        }),
      ),
    },

    devTools: {
      dbAdmin: {
        enabled: dbAdminEnabled,
        port: dbAdminPort,
        image: envApp.devtools?.dbAdmin?.image,
        imagePullPolicy: envApp.devtools?.dbAdmin
          ?.imagePullPolicy as DevToolsConfig["dbAdmin"]["imagePullPolicy"],
      },
    },

    ingress: {
      enabled: ingressEnabled,
      className: ingressClassName,
      annotations: ingressAnnotations,
      ...(envApp.ingress?.tls?.secretName
        ? {
            tls: {
              secretName: envApp.ingress.tls.secretName,
              hosts: envApp.ingress.tls.hosts ?? [],
            },
          }
        : {}),
    },
  };

  return config;
}
