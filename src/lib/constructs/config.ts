/**
 * Configuration Management Constructs
 * For handling ConfigMaps and Secrets in a standardized way
 */

import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { ConfigMap, Secret } from "../k8s";

export interface ConfigMapProps {
  namespace: string;
  name: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
}

/**
 * Standardized ConfigMap construct for application configuration
 */
export class AppConfigMap extends Construct {
  public readonly configMap: ConfigMap;
  public readonly name: string;

  constructor(scope: Construct, id: string, props: ConfigMapProps) {
    super(scope, id);

    this.name = props.name;
    this.configMap = new ConfigMap(this, "configmap", {
      metadata: {
        name: props.name,
        namespace: props.namespace,
        labels: props.labels,
      },
      data: props.data,
    });
  }

  /**
   * Get envFrom reference for injecting all config as environment variables
   */
  envFromRef(): { configMapRef: { name: string } } {
    return { configMapRef: { name: this.name } };
  }

  /**
   * Get specific key reference for individual environment variables
   */
  envRef(key: string): {
    valueFrom: { configMapKeyRef: { name: string; key: string } };
  } {
    return {
      valueFrom: {
        configMapKeyRef: {
          name: this.name,
          key: key,
        },
      },
    };
  }
}

export interface SecretProps {
  namespace: string;
  name: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
  /** Whether data is base64 encoded already */
  stringData?: boolean;
  /**
   * When set, emit an ExternalSecret CRD (External Secrets Operator) instead
   * of a plain Kubernetes Secret. The `data` map keys become remote ref keys.
   *
   * Prerequisites: External Secrets Operator must be installed in the cluster.
   * See https://external-secrets.io/latest/introduction/getting-started/
   */
  externalSecretRef?: {
    /** Name of the SecretStore or ClusterSecretStore resource */
    storeName: string;
    /** "SecretStore" (namespace-scoped) or "ClusterSecretStore" (cluster-wide) */
    storeKind?: "SecretStore" | "ClusterSecretStore";
    /** Remote key path prefix in the backend (e.g. "/prod/futbalio") */
    remoteKeyPrefix?: string;
    /** Refresh interval, e.g. "1h" (default: "1h") */
    refreshInterval?: string;
  };
}

/**
 * Standardized Secret construct for sensitive application configuration.
 *
 * When `props.externalSecretRef` is set an ExternalSecret CRD resource is
 * emitted instead of a plain Kubernetes Secret. The `data` map keys are used
 * as remote ref keys (optionally prefixed by `remoteKeyPrefix`). This mode
 * requires the External Secrets Operator to be installed in the cluster.
 */
export class AppSecret extends Construct {
  public readonly secret: Secret | undefined;
  public readonly name: string;

  constructor(scope: Construct, id: string, props: SecretProps) {
    super(scope, id);

    this.name = props.name;

    if (props.externalSecretRef) {
      const extRef = props.externalSecretRef;
      const storeKind = extRef.storeKind ?? "ClusterSecretStore";
      const prefix = extRef.remoteKeyPrefix ? `${extRef.remoteKeyPrefix}/` : "";

      new ApiObject(this, "external-secret", {
        apiVersion: "external-secrets.io/v1beta1",
        kind: "ExternalSecret",
        metadata: {
          name: props.name,
          namespace: props.namespace,
          labels: props.labels,
        },
        spec: {
          refreshInterval: extRef.refreshInterval ?? "1h",
          secretStoreRef: {
            name: extRef.storeName,
            kind: storeKind,
          },
          target: {
            name: props.name,
            creationPolicy: "Owner",
          },
          data: Object.keys(props.data).map((key) => ({
            secretKey: key,
            remoteRef: {
              key: `${prefix}${key}`,
            },
          })),
        },
      });

      // secret is undefined in external mode — envFromRef/envRef still work
      this.secret = undefined;
    } else {
      const secretSpec =
        props.stringData !== false
          ? {
              stringData: props.data,
            }
          : {
              data: props.data,
            };

      this.secret = new Secret(this, "secret", {
        metadata: {
          name: props.name,
          namespace: props.namespace,
          labels: props.labels,
        },
        ...secretSpec,
      });
    }
  }

  /**
   * Get envFrom reference for injecting all secrets as environment variables
   */
  envFromRef(): { secretRef: { name: string } } {
    return { secretRef: { name: this.name } };
  }

  /**
   * Get specific key reference for individual environment variables
   */
  envRef(key: string): {
    valueFrom: { secretKeyRef: { name: string; key: string } };
  } {
    return {
      valueFrom: {
        secretKeyRef: {
          name: this.name,
          key: key,
        },
      },
    };
  }
}
