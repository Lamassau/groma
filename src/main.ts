import { App } from "cdk8s";
import { buildFullStackConfig, loadDevEnvConfig } from "./lib/config/builder";
import { FEATURES } from "./devenv-config";
import { FutbalioChart } from "./futbalio-chart";

const devEnvConfig = loadDevEnvConfig();

const config = buildFullStackConfig(devEnvConfig, "futbalio", {
  enableMongoDB: FEATURES.ENABLE_MONGODB,
  enableRedis: FEATURES.ENABLE_REDIS,
});

const app = new App({ outdir: "dist" });
new FutbalioChart(app, "futbalio", { config });
app.synth();
