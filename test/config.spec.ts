import { App, Chart, Testing } from "cdk8s";
import { AppConfigMap, AppSecret } from "../src/lib/constructs/config";

describe("AppConfigMap", () => {
  it("renders a ConfigMap with the provided data", () => {
    const chart = new Chart(new App(), "test");
    new AppConfigMap(chart, "cfg", {
      namespace: "test-ns",
      name: "app-config",
      data: { NODE_ENV: "development", LOG_LEVEL: "debug" },
    });
    const manifests = Testing.synth(chart);
    const cm = manifests.find((m: any) => m.kind === "ConfigMap");
    expect(cm).toBeDefined();
    expect(cm.metadata.name).toBe("app-config");
    expect(cm.data.NODE_ENV).toBe("development");
    expect(cm.data.LOG_LEVEL).toBe("debug");
  });

  it("envFromRef returns a configMapRef object", () => {
    const chart = new Chart(new App(), "test");
    const appCfg = new AppConfigMap(chart, "cfg", {
      namespace: "test-ns",
      name: "my-config",
      data: {},
    });
    const ref = appCfg.envFromRef();
    expect(ref).toEqual({ configMapRef: { name: "my-config" } });
  });

  it("envRef returns a valueFrom configMapKeyRef object", () => {
    const chart = new Chart(new App(), "test");
    const appCfg = new AppConfigMap(chart, "cfg", {
      namespace: "test-ns",
      name: "my-config",
      data: {},
    });
    const ref = appCfg.envRef("NODE_ENV");
    expect(ref).toEqual({
      valueFrom: { configMapKeyRef: { name: "my-config", key: "NODE_ENV" } },
    });
  });
});

describe("AppSecret (inline)", () => {
  it("renders a Secret with stringData", () => {
    const chart = new Chart(new App(), "test");
    new AppSecret(chart, "sec", {
      namespace: "test-ns",
      name: "app-secrets",
      data: { JWT_SECRET: "mysecret" },
    });
    const manifests = Testing.synth(chart);
    const secret = manifests.find((m: any) => m.kind === "Secret");
    expect(secret).toBeDefined();
    expect(secret.stringData.JWT_SECRET).toBe("mysecret");
  });

  it("envFromRef returns a secretRef object", () => {
    const chart = new Chart(new App(), "test");
    const sec = new AppSecret(chart, "sec", {
      namespace: "test-ns",
      name: "app-secrets",
      data: {},
    });
    expect(sec.envFromRef()).toEqual({ secretRef: { name: "app-secrets" } });
  });

  it("envRef returns a secretKeyRef object", () => {
    const chart = new Chart(new App(), "test");
    const sec = new AppSecret(chart, "sec", {
      namespace: "test-ns",
      name: "app-secrets",
      data: {},
    });
    const ref = sec.envRef("JWT_SECRET");
    expect(ref).toEqual({
      valueFrom: { secretKeyRef: { name: "app-secrets", key: "JWT_SECRET" } },
    });
  });
});

describe("AppSecret (external-secrets)", () => {
  it("renders an ExternalSecret CRD instead of a plain Secret", () => {
    const chart = new Chart(new App(), "test");
    new AppSecret(chart, "sec", {
      namespace: "test-ns",
      name: "app-secrets",
      data: { JWT_SECRET: "", SESSION_SECRET: "" },
      externalSecretRef: {
        storeName: "my-cluster-store",
        storeKind: "ClusterSecretStore",
        remoteKeyPrefix: "/prod/myapp",
        refreshInterval: "30m",
      },
    });
    const manifests = Testing.synth(chart);
    const extSec = manifests.find((m: any) => m.kind === "ExternalSecret");
    const plainSecret = manifests.find((m: any) => m.kind === "Secret");
    expect(extSec).toBeDefined();
    expect(plainSecret).toBeUndefined();
    expect(extSec.apiVersion).toBe("external-secrets.io/v1beta1");
    expect(extSec.spec.secretStoreRef.name).toBe("my-cluster-store");
    expect(extSec.spec.secretStoreRef.kind).toBe("ClusterSecretStore");
    expect(extSec.spec.refreshInterval).toBe("30m");
    expect(extSec.spec.data).toHaveLength(2);
    const jwtRef = extSec.spec.data.find((d: any) => d.secretKey === "JWT_SECRET");
    expect(jwtRef.remoteRef.key).toBe("/prod/myapp/JWT_SECRET");
  });
});
