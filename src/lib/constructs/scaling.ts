/**
 * Scaling Constructs
 * HorizontalPodAutoscaler and PodDisruptionBudget for production-grade deployments
 */

import { Construct } from "constructs";
import { HorizontalPodAutoscaler, IntOrString, PodDisruptionBudget } from "../k8s";

// ─── HPA ─────────────────────────────────────────────────────────────────────

export interface HpaProps {
  /** Kubernetes namespace */
  namespace: string;
  /** Deployment name to scale (e.g. "api-deployment") */
  deploymentName: string;
  /** Minimum number of pod replicas */
  minReplicas: number;
  /** Maximum number of pod replicas */
  maxReplicas: number;
  /**
   * CPU utilisation percentage that triggers scale-out.
   * Defaults to 70 (%) — scale out when average CPU exceeds 70 %.
   */
  targetCpuUtilizationPercentage?: number;
}

/**
 * HorizontalPodAutoscaler construct.
 *
 * Automatically scales the target Deployment between [minReplicas, maxReplicas]
 * based on CPU utilisation.  Requires the Kubernetes Metrics Server to be
 * deployed in the cluster.
 */
export class AppHpa extends Construct {
  constructor(scope: Construct, id: string, props: HpaProps) {
    super(scope, id);

    new HorizontalPodAutoscaler(this, "hpa", {
      metadata: {
        name: `${props.deploymentName}-hpa`,
        namespace: props.namespace,
      },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: props.deploymentName,
        },
        minReplicas: props.minReplicas,
        maxReplicas: props.maxReplicas,
        targetCpuUtilizationPercentage:
          props.targetCpuUtilizationPercentage ?? 70,
      },
    });
  }
}

// ─── PodDisruptionBudget ──────────────────────────────────────────────────────

export interface PdbProps {
  /** Kubernetes namespace */
  namespace: string;
  /** Label selector key used to match pods (e.g. "app") */
  selectorKey: string;
  /** Label selector value used to match pods (e.g. "api") */
  selectorValue: string;
  /**
   * Minimum number of pods that must remain available during voluntary
   * disruptions (node drains, rolling updates, etc.).
   *
   * Provide either `minAvailable` OR `maxUnavailable` — not both.
   * Defaults to minAvailable: 1.
   */
  minAvailable?: number | string;
  maxUnavailable?: number | string;
}

/**
 * PodDisruptionBudget construct.
 *
 * Ensures that voluntary disruptions (cluster upgrades, node drains) never
 * take too many pods offline simultaneously.  Required for zero-downtime
 * rolling deployments in production.
 */
export class AppPdb extends Construct {
  constructor(scope: Construct, id: string, props: PdbProps) {
    super(scope, id);

    if (props.minAvailable !== undefined && props.maxUnavailable !== undefined) {
      throw new Error(
        `PDB "${props.selectorValue}": provide either minAvailable or maxUnavailable, not both.`,
      );
    }

    const minAvailable =
      props.minAvailable !== undefined ? props.minAvailable : 1;

    new PodDisruptionBudget(this, "pdb", {
      metadata: {
        name: `${props.selectorValue}-pdb`,
        namespace: props.namespace,
      },
      spec: {
        selector: {
          matchLabels: { [props.selectorKey]: props.selectorValue },
        },
        ...(props.maxUnavailable !== undefined
          ? {
              maxUnavailable:
                typeof props.maxUnavailable === "number"
                  ? IntOrString.fromNumber(props.maxUnavailable)
                  : IntOrString.fromString(props.maxUnavailable),
            }
          : {
              minAvailable:
                typeof minAvailable === "number"
                  ? IntOrString.fromNumber(minAvailable)
                  : IntOrString.fromString(minAvailable),
            }),
      },
    });
  }
}
