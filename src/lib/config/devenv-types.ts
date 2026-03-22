/**
 * Types specific to devenv.yaml configuration file
 * This is separate from core types as it's specific to the devenv tool configuration
 */

export interface DevEnvConfig {
  cluster: {
    clusterName: string;
    kubeConfigDir: string;
    domain?: string;
  };
  app?: {
    name?: string;
    domain?: string;
  };
  podman: {
    machine: {
      cpus: number;
      memory: number;
      disk: number;
    };
    registry: string;
  };
  k0s: {
    version: string;
    network: {
      podCIDR: string;
      serviceCIDR: string;
    };
  };
  metallb: {
    version: string;
    poolRange: string;
  };
  traefik: {
    image: string;
    crdUrl: string;
  };
}
