import { App, Chart, Testing } from "cdk8s";
import { NamespaceNetworkPolicies } from "../src/lib/constructs/network-policy";

const defaultProps = {
  namespace: "test-ns",
  appName: "myapp",
  apiPort: 3000,
  webPort: 4200,
  mysqlPort: 3306,
  mongoPort: 27017,
  cachePort: 6379,
};

describe("NamespaceNetworkPolicies", () => {
  it("emits a default-deny NetworkPolicy with empty podSelector", () => {
    const chart = new Chart(new App(), "test");
    new NamespaceNetworkPolicies(chart, "np", defaultProps);
    const manifests = Testing.synth(chart);
    const policies: any[] = manifests.filter((m: any) => m.kind === "NetworkPolicy");
    const deny = policies.find((p: any) => p.metadata.name.includes("default-deny"));
    expect(deny).toBeDefined();
    expect(deny.spec.podSelector).toEqual({});
    expect(deny.spec.policyTypes).toContain("Ingress");
    expect(deny.spec.policyTypes).toContain("Egress");
  });

  it("API allow rule selects pods by app.kubernetes.io/component=api", () => {
    const chart = new Chart(new App(), "test");
    new NamespaceNetworkPolicies(chart, "np", defaultProps);
    const manifests = Testing.synth(chart);
    const policies: any[] = manifests.filter((m: any) => m.kind === "NetworkPolicy");
    const traefikToApi = policies.find((p: any) =>
      p.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] === "api",
    );
    expect(traefikToApi).toBeDefined();
  });

  it("MySQL allow rule selects pods by app.kubernetes.io/component=mysql", () => {
    const chart = new Chart(new App(), "test");
    new NamespaceNetworkPolicies(chart, "np", defaultProps);
    const manifests = Testing.synth(chart);
    const policies: any[] = manifests.filter((m: any) => m.kind === "NetworkPolicy");
    const mysqlPolicy = policies.find((p: any) =>
      p.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] === "mysql",
    );
    expect(mysqlPolicy).toBeDefined();
  });

  it("MongoDB allow rule selects pods by app.kubernetes.io/component=mongodb", () => {
    const chart = new Chart(new App(), "test");
    new NamespaceNetworkPolicies(chart, "np", defaultProps);
    const manifests = Testing.synth(chart);
    const policies: any[] = manifests.filter((m: any) => m.kind === "NetworkPolicy");
    const mongoPolicy = policies.find((p: any) =>
      p.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] === "mongodb",
    );
    expect(mongoPolicy).toBeDefined();
  });

  it("Cache allow rule selects pods by app.kubernetes.io/component=cache", () => {
    const chart = new Chart(new App(), "test");
    new NamespaceNetworkPolicies(chart, "np", defaultProps);
    const manifests = Testing.synth(chart);
    const policies: any[] = manifests.filter((m: any) => m.kind === "NetworkPolicy");
    const cachePolicy = policies.find((p: any) =>
      p.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] === "cache",
    );
    expect(cachePolicy).toBeDefined();
  });
});
