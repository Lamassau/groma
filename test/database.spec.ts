import { App, Chart, Testing } from "cdk8s";
import { MySQLDatabase, MongoDatabase } from "../src/lib/constructs/database";

const mysqlConfig = {
  enabled: true,
  credentials: { database: "testdb", username: "user", password: "secret" },
  storageSize: "10Gi",
};

const mongoConfig = {
  enabled: true,
  credentials: { database: "testdb", username: "user", password: "secret" },
  storageSize: "10Gi",
};

describe("MySQLDatabase", () => {
  it("creates a PVC when storageSize is set", () => {
    const chart = new Chart(new App(), "test");
    new MySQLDatabase(chart, "mysql", {
      namespace: "test-ns",
      appName: "myapp",
      config: mysqlConfig,
    });
    const manifests = Testing.synth(chart);
    const pvc = manifests.find((m: any) => m.kind === "PersistentVolumeClaim");
    expect(pvc).toBeDefined();
  });

  it("creates a Secret with database/username/password keys", () => {
    const chart = new Chart(new App(), "test");
    new MySQLDatabase(chart, "mysql", {
      namespace: "test-ns",
      appName: "myapp",
      config: mysqlConfig,
    });
    const manifests = Testing.synth(chart);
    const secret = manifests.find((m: any) => m.kind === "Secret");
    expect(secret).toBeDefined();
    expect(secret.stringData).toHaveProperty("database");
    expect(secret.stringData).toHaveProperty("username");
    expect(secret.stringData).toHaveProperty("password");
  });

  it("uses mariadb-admin ping as readiness probe command", () => {
    const chart = new Chart(new App(), "test");
    new MySQLDatabase(chart, "mysql", {
      namespace: "test-ns",
      appName: "myapp",
      config: mysqlConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    const probe = dep.spec.template.spec.containers[0].readinessProbe;
    expect(probe.exec.command.join(" ")).toContain("mariadb-admin ping");
  });

  it("sets app.kubernetes.io/component label on the Deployment", () => {
    const chart = new Chart(new App(), "test");
    new MySQLDatabase(chart, "mysql", {
      namespace: "test-ns",
      appName: "myapp",
      config: mysqlConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    expect(dep.metadata.labels["app.kubernetes.io/component"]).toBe("mysql");
  });

  it("does not create a PVC when storageSize is 0", () => {
    const chart = new Chart(new App(), "test");
    new MySQLDatabase(chart, "mysql", {
      namespace: "test-ns",
      appName: "myapp",
      config: { ...mysqlConfig, storageSize: "0" },
    });
    const manifests = Testing.synth(chart);
    const pvcs = manifests.filter((m: any) => m.kind === "PersistentVolumeClaim");
    expect(pvcs).toHaveLength(0);
  });
});

describe("MongoDatabase", () => {
  it("creates a PVC when storageSize is set", () => {
    const chart = new Chart(new App(), "test");
    new MongoDatabase(chart, "mongo", {
      namespace: "test-ns",
      appName: "myapp",
      config: mongoConfig,
    });
    const manifests = Testing.synth(chart);
    const pvc = manifests.find((m: any) => m.kind === "PersistentVolumeClaim");
    expect(pvc).toBeDefined();
  });

  it("sets app.kubernetes.io/component label to 'mongodb'", () => {
    const chart = new Chart(new App(), "test");
    new MongoDatabase(chart, "mongo", {
      namespace: "test-ns",
      appName: "myapp",
      config: mongoConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    expect(dep.metadata.labels["app.kubernetes.io/component"]).toBe("mongodb");
  });
});
