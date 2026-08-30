/**
 * Core types and interfaces for infrastructure configuration.
 * These types are designed to be reusable across any application.
 */

// Environment types
export type Environment = "local" | "dev" | "staging" | "prod";

/**
 * Base configuration interface for any application deployment
 * Designed to be extended by specific application configurations
 */
export interface BaseInfraConfig {
  /** Deployment environment */
  environment: Environment;
  /** Kubernetes namespace for the application */
  namespace: string;
  /** Base domain for ingress routes */
  domain: string;
  /** Application name (used for labeling and naming resources) */
  appName: string;
}

/**
 * Database configuration interface
 * Generic across MySQL, PostgreSQL, etc.
 */
export interface DatabaseConfig {
  enabled: boolean;
  credentials: {
    database: string;
    username: string;
    password: string;
  };
  storageSize: string;
  /** Optional: Absolute path on the cluster node to SQL init scripts */
  initSqlPath?: string;
  /** Optional: StorageClass for the PVC (e.g. openebs-hostpath on k0s native) */
  storageClassName?: string;
  /** Optional: Custom image */
  image?: string;
  /** Optional: Custom port */
  port?: number;
}

/**
 * Cache/Key-Value store configuration
 * Works for Redis, Valkey, etc.
 */
export interface CacheConfig {
  enabled: boolean;
  credentials: {
    password: string;
  };
  storageSize: string;
  /** Optional: StorageClass for the PVC (e.g. openebs-hostpath on k0s native) */
  storageClassName?: string;
  /** Optional: Custom image */
  image?: string;
  /** Optional: Custom port */
  port?: number;
}

/**
 * Application service configuration
 * Generic for any containerized service
 */
export interface ServiceConfig {
  image: string;
  replicas: number;
  port: number;
  /** Container startup command */
  command: string[];
  /** Optional: Kubernetes service type (ClusterIP | NodePort | LoadBalancer) — from env YAML */
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /** Optional: NodePort value (only valid when serviceType is NodePort) — from env YAML */
  nodePort?: number;
  /** Optional: Image pull policy — from env YAML */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** Optional: Debug port (e.g. Node.js --inspect) — from env YAML */
  debugPort?: number;
  /** Optional: NodePort for debug traffic — from env YAML */
  debugNodePort?: number;
  /** Optional: Resource limits */
  resources?: {
    limits?: { cpu: string; memory: string };
    requests?: { cpu: string; memory: string };
  };
  /** Optional: Environment variables */
  env?: Record<string, string>;
  /** Optional: Health check path */
  healthCheck?: string;
}

/**
 * Ingress configuration — maps directly to env/{env}.yaml `ingress` block
 */
export interface IngressConfig {
  /** Standard Kubernetes Ingress by default; opt into Traefik CRDs explicitly. */
  mode?: "standard" | "traefik";
  enabled: boolean;
  className: string;
  annotations?: Record<string, string>;
  /** Optional TLS configuration. When set, a `tls:` block is added to Ingress
   *  resources. Pair with a cert-manager ClusterIssuer annotation to automate
   *  certificate provisioning. */
  tls?: {
    /** Name of the Kubernetes Secret that holds (or will hold) the TLS cert */
    secretName: string;
    /** Hostnames covered by the certificate */
    hosts: string[];
  };
}

/**
 * Development tools configuration
 */
export interface DevToolsConfig {
  /** Database management UI (WhoDB, Adminer, etc.) */
  dbAdmin: {
    enabled: boolean;
    port?: number;
    /** Optional: Custom image (default: cbrainthwaite/whodb:latest) */
    image?: string;
    /** Optional: Image pull policy (default: IfNotPresent) */
    imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  };
}

/**
 * Complete infrastructure configuration for a full-stack application
 * Combines all the individual configurations
 */
export interface FullStackConfig extends BaseInfraConfig {
  /** Non-sensitive environment variables injected into all services via ConfigMap */
  appConfig: Record<string, string>;
  /** Sensitive values injected into backend services via Secret */
  appSecrets: Record<string, string>;
  /** SQL database configuration */
  database: {
    mysql?: DatabaseConfig;
    postgresql?: DatabaseConfig;
  };
  /** NoSQL database configuration */
  nosql: {
    mongodb?: DatabaseConfig;
  };
  /** Cache/session store configuration */
  cache: {
    redis?: CacheConfig;
    valkey?: CacheConfig;
  };
  /** Application services */
  services: {
    api: ServiceConfig;
    web: ServiceConfig;
    /** Optional: Additional services */
    [key: string]: ServiceConfig;
  };
  /** Development tools */
  devTools: DevToolsConfig;
  /** Ingress configuration */
  ingress: IngressConfig;
  /**
   * Controls how Kubernetes Secrets are emitted.
   * - "inline" (default): values written directly into a Secret manifest.
   * - "external-secrets": ExternalSecret CRDs emitted instead (requires ESO).
   */
  secretsBackend: "inline" | "external-secrets";
  /**
   * Required when secretsBackend === "external-secrets".
   * Passed through to AppSecret constructs.
   */
  externalSecretStore?: {
    name: string;
    kind?: "SecretStore" | "ClusterSecretStore";
    remoteKeyPrefix?: string;
    refreshInterval?: string;
  };
}
