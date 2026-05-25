import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadInfraConfig,
  generatePassword,
} from "../src/lib/config/builder";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTempConfig(
  commonEnv: string,
  localEnv: string,
  localYaml: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infra-builder-test-"));
  fs.writeFileSync(path.join(dir, "common.env"), commonEnv, "utf8");
  fs.mkdirSync(path.join(dir, "local"), { recursive: true });
  fs.writeFileSync(path.join(dir, "local", ".env"), localEnv, "utf8");

  // resources dir is resolved relative to devenv-config PATHS which uses __dirname
  // so we need to override INFRA_RESOURCES_DIR env var or pass the dir directly.
  // loadInfraConfig only reads config dir; resources come from getResourcesDir().
  // For the merge test we only need to verify common + app layers.
  return dir;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("loadInfraConfig", () => {
  it("merges common.env and local/.env into a single object", () => {
    const dir = makeTempConfig(
      // common.env
      "SERVICES__API__PORT=3000\n",
      // local/.env
      "ENVIRONMENT=local\nNAMESPACE=myapp-local\n",
      "",
    );
    const config = loadInfraConfig("local", dir);
    // port is parsed from env as string; coerce to number for comparison
    expect(Number(config.common.services?.["api"]?.port)).toBe(3000);
    expect(config.app.namespace).toBe("myapp-local");
  });

  it("returns empty objects when files are missing (graceful)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infra-builder-test-empty-"));
    const config = loadInfraConfig("nonexistent", dir);
    expect(config.common).toEqual({});
    expect(config.app).toEqual({});
    expect(config.resources).toEqual({});
  });

  it("parses nested APP_CONFIG values into appConfig record", () => {
    const dir = makeTempConfig(
      "",
      "ENVIRONMENT=local\nNAMESPACE=ns\nAPP_CONFIG__NODE_ENV=development\nAPP_CONFIG__LOG_LEVEL=debug\n",
      "",
    );
    const config = loadInfraConfig("local", dir);
    expect(config.app.appConfig?.NODE_ENV).toBe("development");
    expect(config.app.appConfig?.LOG_LEVEL).toBe("debug");
  });

  it("parses APP_SECRETS values into appSecrets record", () => {
    const dir = makeTempConfig(
      "",
      "ENVIRONMENT=local\nNAMESPACE=ns\nAPP_SECRETS__JWT_SECRET=supersecret\n",
      "",
    );
    const config = loadInfraConfig("local", dir);
    expect(config.app.appSecrets?.JWT_SECRET).toBe("supersecret");
  });
});

describe("generatePassword", () => {
  it("generates a password of the requested length (default 24)", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(24);
  });

  it("generates a password of a custom length", () => {
    const pw = generatePassword(32);
    expect(pw).toHaveLength(32);
  });

  it("generates different passwords on each call (cryptographically random)", () => {
    const pw1 = generatePassword();
    const pw2 = generatePassword();
    expect(pw1).not.toBe(pw2);
  });
});
