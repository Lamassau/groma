/**
 * Configuration Management Constructs
 * For handling ConfigMaps and Secrets in a standardized way
 */

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
}

/**
 * Standardized Secret construct for sensitive application configuration
 */
export class AppSecret extends Construct {
  public readonly secret: Secret;
  public readonly name: string;

  constructor(scope: Construct, id: string, props: SecretProps) {
    super(scope, id);

    this.name = props.name;

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
