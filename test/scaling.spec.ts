import { App, Chart, Testing } from "cdk8s";
import { AppHpa, AppPdb } from "../src/lib/constructs/scaling";

describe("AppHpa", () => {
  it("renders a HorizontalPodAutoscalerV2 with correct min/max replicas", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppHpa(chart, "api-hpa", {
      namespace: "test-ns",
      deploymentName: "api-deployment",
      minReplicas: 2,
      maxReplicas: 6,
      targetCpuUtilizationPercentage: 70,
    });

    const manifests = Testing.synth(chart);
    const hpa = manifests.find((m: any) => m.kind === "HorizontalPodAutoscaler");

    expect(hpa).toBeDefined();
    expect(hpa.apiVersion).toBe("autoscaling/v2");
    expect(hpa.metadata.name).toBe("api-deployment-hpa");
    expect(hpa.metadata.namespace).toBe("test-ns");
    expect(hpa.spec.minReplicas).toBe(2);
    expect(hpa.spec.maxReplicas).toBe(6);
    expect(hpa.spec.scaleTargetRef.name).toBe("api-deployment");
    expect(hpa.spec.scaleTargetRef.kind).toBe("Deployment");
    // v2 uses metrics[] instead of targetCPUUtilizationPercentage
    const cpuMetric = hpa.spec.metrics?.find((m: any) => m.type === "Resource" && m.resource?.name === "cpu");
    expect(cpuMetric).toBeDefined();
    expect(cpuMetric.resource.target.averageUtilization).toBe(70);
  });

  it("defaults targetCpuUtilizationPercentage to 70", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppHpa(chart, "web-hpa", {
      namespace: "test-ns",
      deploymentName: "web-deployment",
      minReplicas: 1,
      maxReplicas: 3,
    });

    const manifests = Testing.synth(chart);
    const hpa = manifests.find((m: any) => m.kind === "HorizontalPodAutoscaler");
    const cpuMetric = hpa.spec.metrics?.find((m: any) => m.type === "Resource" && m.resource?.name === "cpu");

    expect(cpuMetric.resource.target.averageUtilization).toBe(70);
  });
});

describe("AppPdb", () => {
  it("renders a PodDisruptionBudget with explicit minAvailable", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppPdb(chart, "api-pdb", {
      namespace: "test-ns",
      selectorKey: "app",
      selectorValue: "api",
      replicas: 3,
      minAvailable: 2,
    });

    const manifests = Testing.synth(chart);
    const pdb = manifests.find((m: any) => m.kind === "PodDisruptionBudget");

    expect(pdb).toBeDefined();
    expect(pdb.metadata.name).toBe("api-pdb");
    expect(pdb.metadata.namespace).toBe("test-ns");
    expect(pdb.spec.selector.matchLabels).toEqual({ app: "api" });
    expect(pdb.spec.minAvailable).toBe(2);
    expect(pdb.spec.maxUnavailable).toBeUndefined();
  });

  it("renders a PodDisruptionBudget with maxUnavailable", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppPdb(chart, "web-pdb", {
      namespace: "test-ns",
      selectorKey: "app",
      selectorValue: "web",
      maxUnavailable: 1,
    });

    const manifests = Testing.synth(chart);
    const pdb = manifests.find((m: any) => m.kind === "PodDisruptionBudget");

    expect(pdb.spec.maxUnavailable).toBe(1);
    expect(pdb.spec.minAvailable).toBeUndefined();
  });

  it("defaults to maxUnavailable: 1 when neither is specified", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppPdb(chart, "api-pdb", {
      namespace: "test-ns",
      selectorKey: "app",
      selectorValue: "api",
    });

    const manifests = Testing.synth(chart);
    const pdb = manifests.find((m: any) => m.kind === "PodDisruptionBudget");

    expect(pdb.spec.maxUnavailable).toBe(1);
    expect(pdb.spec.minAvailable).toBeUndefined();
  });

  it("throws when minAvailable >= replicas (deadlock guard)", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    expect(() => {
      new AppPdb(chart, "bad-pdb", {
        namespace: "test-ns",
        selectorKey: "app",
        selectorValue: "api",
        replicas: 1,
        minAvailable: 1,
      });
    }).toThrow(/minAvailable.*must be less than replicas/);
  });
});
