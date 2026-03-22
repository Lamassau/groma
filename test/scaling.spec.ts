import { App, Chart, Testing } from "cdk8s";
import { AppHpa, AppPdb } from "../src/lib/constructs/scaling";

describe("AppHpa", () => {
  it("renders a HorizontalPodAutoscaler with correct min/max replicas", () => {
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
    expect(hpa.metadata.name).toBe("api-deployment-hpa");
    expect(hpa.metadata.namespace).toBe("test-ns");
    expect(hpa.spec.minReplicas).toBe(2);
    expect(hpa.spec.maxReplicas).toBe(6);
    expect(hpa.spec.targetCPUUtilizationPercentage).toBe(70);
    expect(hpa.spec.scaleTargetRef.name).toBe("api-deployment");
    expect(hpa.spec.scaleTargetRef.kind).toBe("Deployment");
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

    expect(hpa.spec.targetCPUUtilizationPercentage).toBe(70);
  });
});

describe("AppPdb", () => {
  it("renders a PodDisruptionBudget with minAvailable", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppPdb(chart, "api-pdb", {
      namespace: "test-ns",
      selectorKey: "app",
      selectorValue: "api",
      minAvailable: 1,
    });

    const manifests = Testing.synth(chart);
    const pdb = manifests.find((m: any) => m.kind === "PodDisruptionBudget");

    expect(pdb).toBeDefined();
    expect(pdb.metadata.name).toBe("api-pdb");
    expect(pdb.metadata.namespace).toBe("test-ns");
    expect(pdb.spec.selector.matchLabels).toEqual({ app: "api" });
    expect(pdb.spec.minAvailable).toBe(1);
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

  it("defaults minAvailable to 1 when neither is specified", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new AppPdb(chart, "api-pdb", {
      namespace: "test-ns",
      selectorKey: "app",
      selectorValue: "api",
    });

    const manifests = Testing.synth(chart);
    const pdb = manifests.find((m: any) => m.kind === "PodDisruptionBudget");

    expect(pdb.spec.minAvailable).toBe(1);
  });
});
