import { App, Testing } from "cdk8s";
import { FullStackChart } from "../src/lib/charts/full-stack";
import { FullStackConfig } from "../src/lib/core/types";

const baseServices = {
  api: {
    image: "registry.example.com/myapp-api:local",
    replicas: 1,
    port: 3000,
    command: ["node", "dist/main.js"],
    healthCheck: "/api/health",
    serviceType: "ClusterIP" as const,
    resources: {
      limits: { cpu: "500m", memory: "512Mi" },
      requests: { cpu: "100m", memory: "128Mi" },
    },
  },
  web: {
    image: "registry.example.com/myapp-web:local",
    replicas: 1,
    port: 4200,
    command: ["pnpm", "start"],
    healthCheck: "/",
    serviceType: "ClusterIP" as const,
    resources: {
      limits: { cpu: "250m", memory: "256Mi" },
      requests: { cpu: "50m", memory: "64Mi" },
    },
  },
};

function makeConfig(overrides: Partial<FullStackConfig> = {}): FullStackConfig {
  return {
    environment: "local",
    namespace: "myapp-local",
    domain: "myapp.local",
    appName: "myapp",
    appConfig: { NODE_ENV: "development" },
    appSecrets: { JWT_SECRET: "devsecret" },
    secretsBackend: "inline",
    database: {
      mysql: {
        enabled: true,
        credentials: { database: "mydb", username: "user", password: "pass" },
        storageSize: "1Gi",
      },
    },
    nosql: {
      mongodb: {
        enabled: true,
        credentials: { database: "mydb", username: "user", password: "pass" },
        storageSize: "1Gi",
      },
    },
    cache: {
      valkey: {
        enabled: true,
        credentials: { password: "cachepass" },
        storageSize: "512Mi",
      },
    },
    services: { ...baseServices },
    devTools: {
      dbAdmin: { enabled: false },
    },
    ingress: {
      enabled: true,
      className: "traefik",
      annotations: {},
    },
    ...overrides,
  };
}

describe("FullStackChart", () => {
  it("emits a Namespace resource", () => {
    const app = new App();
    const chart = new FullStackChart(app, "chart", { config: makeConfig() });
    const manifests = Testing.synth(chart);
    const ns = manifests.find((m: any) => m.kind === "Namespace");
    expect(ns).toBeDefined();
    expect(ns.metadata.name).toBe("myapp-local");
  });

  it("emits a LimitRange and ResourceQuota", () => {
    const app = new App();
    const chart = new FullStackChart(app, "chart", { config: makeConfig() });
    const manifests = Testing.synth(chart);
    expect(manifests.find((m: any) => m.kind === "LimitRange")).toBeDefined();
    expect(manifests.find((m: any) => m.kind === "ResourceQuota")).toBeDefined();
  });

  it("does NOT emit HPA/PDB in local environment", () => {
    const app = new App();
    const chart = new FullStackChart(app, "chart", { config: makeConfig() });
    const manifests = Testing.synth(chart);
    const hpas = manifests.filter((m: any) => m.kind === "HorizontalPodAutoscaler");
    const pdbs = manifests.filter((m: any) => m.kind === "PodDisruptionBudget");
    expect(hpas).toHaveLength(0);
    expect(pdbs).toHaveLength(0);
  });

  it("emits HPA and PDB in staging environment", () => {
    const app = new App();
    const chart = new FullStackChart(app, "chart", {
      config: makeConfig({
        environment: "staging",
        services: {
          api: { ...baseServices.api, replicas: 2 },
          web: { ...baseServices.web, replicas: 2 },
        },
      }),
    });
    const manifests = Testing.synth(chart);
    const hpas = manifests.filter((m: any) => m.kind === "HorizontalPodAutoscaler");
    const pdbs = manifests.filter((m: any) => m.kind === "PodDisruptionBudget");
    expect(hpas.length).toBeGreaterThanOrEqual(2);
    expect(pdbs.length).toBeGreaterThanOrEqual(2);
  });

  it("emits a MariaDbBackup CronJob in staging but not local", () => {
    const localApp = new App();
    const localChart = new FullStackChart(localApp, "chart", { config: makeConfig() });
    const localManifests = Testing.synth(localChart);
    expect(localManifests.filter((m: any) => m.kind === "CronJob")).toHaveLength(0);

    const stagingApp = new App();
    const stagingChart = new FullStackChart(stagingApp, "chart", {
      config: makeConfig({
        environment: "staging",
        services: {
          api: { ...baseServices.api, replicas: 2 },
          web: { ...baseServices.web, replicas: 2 },
        },
      }),
    });
    const stagingManifests = Testing.synth(stagingChart);
    expect(stagingManifests.filter((m: any) => m.kind === "CronJob").length).toBeGreaterThanOrEqual(1);
  });

  it("does not emit DatabaseAdmin in prod environment", () => {
    const app = new App();
    const chart = new FullStackChart(app, "chart", {
      config: makeConfig({
        environment: "prod",
        devTools: { dbAdmin: { enabled: true } },
        services: {
          api: { ...baseServices.api, replicas: 3 },
          web: { ...baseServices.web, replicas: 3 },
        },
      }),
    });
    const manifests = Testing.synth(chart);
    // DatabaseAdmin deploys a Deployment for WhoDB
    const deploys: any[] = manifests.filter((m: any) => m.kind === "Deployment");
    const whodb = deploys.find((d: any) =>
      JSON.stringify(d).toLowerCase().includes("whodb"),
    );
    expect(whodb).toBeUndefined();
  });

  it("emits a TLS block on Ingress when cfg.ingress.tls is set", () => {
    const app = new App();
    const chart = new FullStackChart(app, "chart", {
      config: makeConfig({
        ingress: {
          enabled: true,
          className: "traefik",
          tls: { secretName: "myapp-tls", hosts: ["api.myapp.example.com"] },
        },
      }),
    });
    const manifests = Testing.synth(chart);
    const ingresses: any[] = manifests.filter((m: any) => m.kind === "Ingress");
    expect(ingresses.length).toBeGreaterThanOrEqual(1);
    for (const ing of ingresses) {
      expect(ing.spec.tls).toBeDefined();
      expect(ing.spec.tls[0].secretName).toBe("myapp-tls");
    }
  });
});
