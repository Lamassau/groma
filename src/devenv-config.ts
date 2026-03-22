/**
 * Centralized DevEnv Configuration
 *
 * This file contains all path configurations and default values for the
 * infrastructure code. Update this file when changing directory structures
 * or default settings.
 *
 * All paths are relative to the .infra/src directory unless otherwise noted.
 */

import * as path from "path";

/**
 * Directory Configuration
 * All paths are relative to .infra/src/
 */
export const PATHS = {
  /**
   * Path to config directory containing environment .env files
   * Default: .devenv/config/ (2 levels up from .infra/src/)
   */
  CONFIG_DIR: path.join(__dirname, "../../config"),

  /**
   * Path to resources directory containing environment YAML files
   * Default: .devenv/.infra/resources/ (1 level up from .infra/src/)
   */
  RESOURCES_DIR: path.join(__dirname, "../resources"),

  /**
   * Path to devenv.yaml for loading cluster configuration
   * Default: .devenv/devenv.yaml (2 levels up from .infra/src/)
   */
  DEVENV_YAML: path.join(__dirname, "../../devenv.yaml"),

  /**
   * CDK8s output directory for generated manifests
   */
  OUTPUT_DIR: "dist",
} as const;

/**
 * Application Defaults
 */
export const APP_DEFAULTS = {
  /**
   * Default application name
   */
  NAME: "futbalio",

  /**
   * Default domain suffix for local development
   */
  DOMAIN_SUFFIX: "local",

  /**
   * Default environment when not specified
   */
  ENVIRONMENT: "local",

  /**
   * Default registry for container images
   */
  REGISTRY: "registry.gitlab.com/lamassau/registry",
} as const;

/**
 * Feature Flags
 * Control which optional services are enabled
 */
export const FEATURES = {
  /**
   * Enable MongoDB for document storage
   */
  ENABLE_MONGODB: true,

  /**
   * Enable Redis/Valkey for caching and sessions
   */
  ENABLE_REDIS: true,

  /**
   * Enable Keycloak for authentication
   */
  ENABLE_KEYCLOAK: false,
} as const;

/**
 * Kubernetes Configuration
 */
export const K8S = {
  /**
   * MetalLB namespace
   */
  METALLB_NAMESPACE: "metallb-system",

  /**
   * MetalLB IP pool name
   */
  METALLB_POOL_NAME: "default-pool",

  /**
   * Traefik namespace
   */
  TRAEFIK_NAMESPACE: "traefik-system",

  /**
   * Default Traefik replicas
   */
  TRAEFIK_REPLICAS: 1,
} as const;

/**
 * Environment-specific namespace pattern
 * @param appName - Application name
 * @param env - Environment name
 * @returns Kubernetes namespace name
 */
export function getNamespace(appName: string, env: string): string {
  return env === "local" ? "local" : `${appName}-${env}`;
}

/**
 * Get full domain for an environment
 * @param appName - Application name
 * @param env - Environment name
 * @param customDomain - Optional custom domain
 * @returns Full domain name
 */
export function getDomain(
  appName: string,
  env: string,
  customDomain?: string,
): string {
  if (customDomain) return customDomain;
  return env === "local"
    ? `${appName}.${APP_DEFAULTS.DOMAIN_SUFFIX}`
    : `${appName}.${env}`;
}

/**
 * Get configuration directory path
 * Can be overridden with INFRA_CONFIG_DIR environment variable
 */
export function getConfigDir(): string {
  return process.env.INFRA_CONFIG_DIR ?? PATHS.CONFIG_DIR;
}

/**
 * Get resources directory path
 * Can be overridden with INFRA_RESOURCES_DIR environment variable
 */
export function getResourcesDir(): string {
  return process.env.INFRA_RESOURCES_DIR ?? PATHS.RESOURCES_DIR;
}
