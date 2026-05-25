import { App, Chart, Testing } from "cdk8s";
import { ApplicationService, ApiService } from "../src/lib/constructs/service";

const baseConfig = {
  image: "registry.example.com/test-api:latest",
  replicas: 2,
  port: 3000,
  command: ["node", "dist/main.js"],
  healthCheck: "/api/health",
};

describe("ApplicationService", () => {
  it("renders a Deployment with the correct replica count", () => {
    const chart = new Chart(new App(), "test");
    new ApplicationService(chart, "api", {
      namespace: "test-ns",
      appName: "myapp",
      config: baseConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    expect(dep).toBeDefined();
    expect(dep.spec.replicas).toBe(2);
  });

  it("sets the correct container port", () => {
    const chart = new Chart(new App(), "test");
    new ApplicationService(chart, "api", {
      namespace: "test-ns",
      appName: "myapp",
      config: baseConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    const ports: any[] = dep.spec.template.spec.containers[0].ports;
    expect(ports.find((p: any) => p.name === "http").containerPort).toBe(3000);
  });

  it("adds HTTP health probes when healthCheck is set", () => {
    const chart = new Chart(new App(), "test");
    new ApplicationService(chart, "api", {
      namespace: "test-ns",
      appName: "myapp",
      config: baseConfig,
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    const container = dep.spec.template.spec.containers[0];
    expect(container.startupProbe).toBeDefined();
    expect(container.readinessProbe).toBeDefined();
    expect(container.livenessProbe).toBeDefined();
  });

  it("sets NodePort on the Service when serviceType is NodePort", () => {
    const chart = new Chart(new App(), "test");
    new ApplicationService(chart, "api", {
      namespace: "test-ns",
      appName: "myapp",
      config: { ...baseConfig, replicas: 1 },
      serviceType: "NodePort",
      nodePort: 30001,
    });
    const manifests = Testing.synth(chart);
    const svc = manifests.find((m: any) => m.kind === "Service");
    expect(svc.spec.type).toBe("NodePort");
    expect(svc.spec.ports[0].nodePort).toBe(30001);
  });

  it("adds a debug port to the Deployment and Service when debugPort is set", () => {
    const chart = new Chart(new App(), "test");
    new ApplicationService(chart, "api", {
      namespace: "test-ns",
      appName: "myapp",
      config: {
        ...baseConfig,
        replicas: 1,
        debugPort: 9229,
        debugNodePort: 30229,
        serviceType: "NodePort",
      },
      serviceType: "NodePort",
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    const svc = manifests.find((m: any) => m.kind === "Service");
    const depPorts: any[] = dep.spec.template.spec.containers[0].ports;
    const svcPorts: any[] = svc.spec.ports;

    expect(depPorts.find((p: any) => p.name === "debug")).toBeDefined();
    expect(depPorts.find((p: any) => p.name === "debug").containerPort).toBe(9229);
    const debugSvcPort = svcPorts.find((p: any) => p.name === "debug");
    expect(debugSvcPort).toBeDefined();
    expect(debugSvcPort.port).toBe(9229);
    expect(debugSvcPort.nodePort).toBe(30229);
  });

  it("sets app.kubernetes.io/component label on the Deployment", () => {
    const chart = new Chart(new App(), "test");
    new ApiService(chart, "api", {
      namespace: "test-ns",
      appName: "myapp",
      config: { ...baseConfig, replicas: 1 },
    });
    const manifests = Testing.synth(chart);
    const dep = manifests.find((m: any) => m.kind === "Deployment");
    expect(dep.metadata.labels["app.kubernetes.io/component"]).toBeDefined();
  });
});
