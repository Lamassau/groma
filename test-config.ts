import { loadInfraConfig } from "./src/lib/config/builder";

console.log("\n=== Testing Config Loading ===\n");

try {
  const config = loadInfraConfig("dev");

  console.log("Environment Config Loaded:");
  console.log("- Has app:", !!config.app);
  console.log("- Has appConfig:", !!config.app?.appConfig);
  console.log("- Has appSecrets:", !!config.app?.appSecrets);
  console.log("- Has services:", !!config.app?.services);

  if (config.app?.appConfig) {
    console.log("\nappConfig keys:", Object.keys(config.app.appConfig));
    console.log(
      "appConfig values:",
      JSON.stringify(config.app.appConfig, null, 2),
    );
  }

  if (config.app?.appSecrets) {
    console.log("\nappSecrets keys:", Object.keys(config.app.appSecrets));
  }

  if (config.app?.services) {
    console.log("\nservices:", Object.keys(config.app.services));
  }

  console.log("\n=== Config Loading Success ===\n");
} catch (error) {
  console.error("Error loading config:", error);
  process.exit(1);
}
