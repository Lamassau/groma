import { App, Chart, Testing } from "cdk8s";
import { RedisCache, ValkeyCache } from "../src/lib/constructs/cache";

const cacheConfig = {
  enabled: true,
  credentials: { password: "cachepassword" },
  storageSize: "2Gi",
};

describe("RedisCache", () => {
  it("creates a Secret with a 'password' key", () => {
    const chart = new Chart(new App(), "test");
    new RedisCache(chart, "cache", {
      namespace: "test-ns",
      appName: "myapp",
      config: cacheConfig,
    });
    const manifests = Testing.synth(chart);
    const secret = manifests.find((m: any) => m.kind === "Secret");
    expect(secret).toBeDefined();
    expect(secret.stringData).toHaveProperty("password");
  });

  it("creates a PVC when storageSize is set", () => {
    const chart = new Chart(new App(), "test");
    new RedisCache(chart, "cache", {
      namespace: "test-ns",
      appName: "myapp",
      config: cacheConfig,
    });
    const manifests = Testing.synth(chart);
    const pvc = manifests.find((m: any) => m.kind === "PersistentVolumeClaim");
    expect(pvc).toBeDefined();
  });

  it("does not create a PVC when storageSize is 0", () => {
    const chart = new Chart(new App(), "test");
    new RedisCache(chart, "cache", {
      namespace: "test-ns",
      appName: "myapp",
      config: { ...cacheConfig, storageSize: "0" },
    });
    const manifests = Testing.synth(chart);
    const pvcs = manifests.filter((m: any) => m.kind === "PersistentVolumeClaim");
    expect(pvcs).toHaveLength(0);
  });

  it("sets app.kubernetes.io/component label to 'cache'", () => {
    const chart = new Chart(new App(), "test");
    new RedisCache(chart, "cache", {
      namespace: "test-ns",
      appName: "myapp",
      config: cacheConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    expect(dep.metadata.labels["app.kubernetes.io/component"]).toBe("cache");
  });
});

describe("ValkeyCache", () => {
  it("sets app.kubernetes.io/component label to 'cache'", () => {
    const chart = new Chart(new App(), "test");
    new ValkeyCache(chart, "valkey", {
      namespace: "test-ns",
      appName: "myapp",
      config: cacheConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    expect(dep.metadata.labels["app.kubernetes.io/component"]).toBe("cache");
  });
});
