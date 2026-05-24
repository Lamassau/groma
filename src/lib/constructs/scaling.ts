import { Construct } from "constructs";
import {
  HorizontalPodAutoscalerV2,
  IntOrString,
  MetricSpecV2,
  PodDisruptionBudget,
} from "../k8s";

// ─── HPA ─────────────────────────────────────────────────────────────────────

export interface HpaProps {
  namespace: string;
  deploymentName: string;
  minReplicas: number;
  maxReplicas: number;
  /** CPU utilisation % that triggers scale-out. Defaults to 70. */
  targetCpuUtilizationPercentage?: number;
}

/**
 * HPA using autoscaling/v2 (stable since Kubernetes 1.23).
 * Requires Metrics Server in the cluster.
 */
export class AppHpa extends Construct {
  constructor(scope: Construct, id: string, props: HpaProps) {
    super(scope, id);

    const cpuTarget = props.targetCpuUtilizationPercentage ?? 70;

    const cpuMetric: MetricSpecV2 = {
      type: "Resource",
      resource: {
        name: "cpu",
        target: {
          type: "Utilization",
          averageUtilization: cpuTarget,
        },
      },
    };

    new HorizontalPodAutoscalerV2(this, "hpa", {
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
        metrics: [cpuMetric],
      },
    });
  }
}

// ─── PodDisruptionBudget ──────────────────────────────────────────────────────

export interface PdbProps {
  namespace: string;
  selectorKey: string;
  selectorValue: string;
  /**
   * Number of replicas on the target Deployment — used to guard against
   * minAvailable values that would deadlock rolling updates.
   */
  replicas?: number;
  /**
   * Provide either `minAvailable` OR `maxUnavailable` — not both.
   * Defaults to maxUnavailable: 1 (safe for single-replica deployments).
   */
  minAvailable?: number | string;
  maxUnavailable?: number | string;
}

/**
 * PodDisruptionBudget construct.
 * Defaults to `maxUnavailable: 1` rather than `minAvailable: 1` to avoid
 * blocking rolling updates on single-replica deployments.
 */
export class AppPdb extends Construct {
  constructor(scope: Construct, id: string, props: PdbProps) {
    super(scope, id);

    if (props.minAvailable !== undefined && props.maxUnavailable !== undefined) {
      throw new Error(
        `PDB "${props.selectorValue}": provide either minAvailable or maxUnavailable, not both.`,
      );
    }

    // Guard: minAvailable >= replicas deadlocks rolling updates
    if (
      props.replicas !== undefined &&
      typeof props.minAvailable === "number" &&
      props.minAvailable >= props.replicas
    ) {
      throw new Error(
        `PDB "${props.selectorValue}": minAvailable (${props.minAvailable}) must be less than replicas (${props.replicas}). ` +
          `Use maxUnavailable: 1 instead, or increase replica count.`,
      );
    }

    // Default to maxUnavailable: 1 — safe even for single-replica deployments
    const useMaxUnavailable =
      props.minAvailable === undefined && props.maxUnavailable === undefined;
    const maxUnavailable = useMaxUnavailable ? 1 : props.maxUnavailable;
    const minAvailable = props.minAvailable;

    new PodDisruptionBudget(this, "pdb", {
      metadata: {
        name: `${props.selectorValue}-pdb`,
        namespace: props.namespace,
      },
      spec: {
        selector: {
          matchLabels: { [props.selectorKey]: props.selectorValue },
        },
        ...(maxUnavailable !== undefined
          ? {
              maxUnavailable:
                typeof maxUnavailable === "number"
                  ? IntOrString.fromNumber(maxUnavailable)
                  : IntOrString.fromString(maxUnavailable),
            }
          : {
              minAvailable:
                typeof minAvailable === "number"
                  ? IntOrString.fromNumber(minAvailable!)
                  : IntOrString.fromString(minAvailable as string),
            }),
      },
    });
  }
}
