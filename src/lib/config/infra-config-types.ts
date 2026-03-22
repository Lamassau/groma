/**
 * TypeScript types matching the config file shapes under .infra/config/
 *
 * Three layers are loaded and merged:
 *   1. config/common.env          – defaults shared across all environments
 *   2. config/{env}/.env           – app behaviour (replicas, ports, env vars, credentials)
 *   3. .infra/resources/{env}.yaml – infra sizing (CPU/memory, storage)
 */

export interface ResourceSpec {
  cpu: string;
  memory: string;
}

export interface ServiceResources {
  limits?: ResourceSpec;
  requests?: ResourceSpec;
}

// ─── Layer 1: common.env ──────────────────────────────────────────────────────

export interface CommonConfig {
  app?: {
    name?: string;
    version?: string;
  };
  build?: {
    registry?: string;
  };
  services?: {
    [name: string]: {
      port?: number;
      targetPort?: number;
      healthCheck?: string;
    };
  };
  databases?: {
    [name: string]: {
      port?: number;
      image?: string;
      initSqlPath?: string;
    };
  };
}

// ─── Layer 2: env/{env}.env ───────────────────────────────────────────────────

export interface EnvAppConfig {
  environment?: string;
  namespace?: string;
  domain?: string;
  /** Non-sensitive env vars → Kubernetes ConfigMap, injected into all services */
  appConfig?: Record<string, string>;
  /** Sensitive values → Kubernetes Secret, injected into backend services */
  appSecrets?: Record<string, string>;
  services?: {
    [name: string]: {
      replicas?: number;
      serviceType?: string;
      nodePort?: number;
      debugPort?: number;
      debugNodePort?: number;
      imagePullPolicy?: string;
      command?: string[];
      healthCheck?: string;
      env?: Record<string, string>;
    };
  };
  databases?: {
    [name: string]: {
      enabled?: boolean;
      initSqlPath?: string;
      storageClassName?: string;
      credentials?: {
        database?: string;
        username?: string;
        password?: string;
      };
    };
  };
  devtools?: {
    dbAdmin?: {
      enabled?: boolean;
      port?: number;
      image?: string;
      imagePullPolicy?: string;
    };
  };
  ingress?: {
    enabled?: boolean;
    className?: string;
    annotations?: Record<string, string>;
  };
}

// ─── Layer 3: env/resources/{env}.yaml ───────────────────────────────────────

export interface EnvResourceConfig {
  services?: {
    [name: string]: {
      resources?: ServiceResources;
    };
  };
  databases?: {
    [name: string]: {
      storageSize?: string;
    };
  };
}

// ─── Merged result ────────────────────────────────────────────────────────────

export interface MergedInfraConfig {
  common: CommonConfig;
  app: EnvAppConfig;
  resources: EnvResourceConfig;
}
