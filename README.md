# .infra — CDK8s Infrastructure

Kubernetes infrastructure defined in TypeScript using **CDK8s**. Generates Kubernetes YAML manifests from a layered config system. No raw YAML to maintain.

---

## How it works

```
Config files (.env + YAML)  →  builder.ts  →  CDK8s constructs  →  dist/*.yaml  →  kubectl apply
```

1. Three config layers are loaded and merged per environment
2. The merged config is passed to TypeScript constructs as a typed `FullStackConfig`
3. `cdk8s synth` (via `ts-node`) generates `dist/` manifests
4. `kubectl apply -f dist/` deploys to the cluster

`pnpm run build` is **type-check only** (`tsc --noEmit`). No compiled JS is ever emitted into `src/`.

---

## Directory structure

```
.devenv/
├── config/                           # Configuration files (shared with other tools)
│   ├── common.env                    # Layer 1 — shared defaults (ports, images)
│   └── env/
│       ├── local.env                 # Layer 2 — local app config
│       ├── dev.env                   # Layer 2 — dev app config
│       └── resources/
│           ├── local.yaml            # Layer 3 — local CPU/memory/storage sizing
│           └── dev.yaml              # Layer 3 — dev CPU/memory/storage sizing
│
└── .infra/
    ├── cdk8s.yaml                    # CDK8s entrypoint (calls ts-node src/main.ts)
    ├── package.json
    ├── tsconfig.json
    │
    └── src/
        ├── main.ts                   # CDK8s App entry point
        ├── futbalio-chart.ts         # App-specific chart (thin wrapper)
        └── lib/                      # Reusable library (framework-agnostic)
            ├── k8s.ts                # Committed K8s API types (do not delete)
            ├── index.ts              # Barrel export
            ├── charts/
            │   ├── full-stack.ts     # Reusable full-stack chart pattern
            │   ├── metallb-config.ts
            │   └── traefik.ts
            ├── constructs/
            │   ├── service.ts        # ApplicationService, ApiService, WebService
        │   ├── database.ts           # MySQLDatabase, MongoDatabase
        │   ├── cache.ts              # RedisCache, ValkeyCache
        │   ├── config.ts             # AppConfigMap, AppSecret
        │   └── devtools.ts           # DatabaseAdmin (WhoDB)
        ├── config/
        │   ├── builder.ts            # Loads + merges config → FullStackConfig
        │   ├── infra-config-types.ts # Config layer TypeScript types
        │   └── devenv-types.ts       # devenv.yaml TypeScript types
        └── core/
            └── types.ts              # FullStackConfig and all shared interfaces
```

---

## Configuration system

Three config layers are merged in priority order (highest wins):

| Layer         | File                          | What goes here                                                                                    |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| 1 — Common    | `config/common.env`           | Shared defaults: ports, DB images                                                                 |
| 2 — App       | `config/{env}.env`            | App behaviour: replicas, commands, env vars, credentials, ingress                                 |
| 3 — Resources | `.infra/resources/{env}.yaml` | Infra sizing: CPU, memory, storage. **Keep separate so ops can tune without touching app config** |

All values are **required** — the builder throws a descriptive error if anything is missing, rather than silently using a default.

### Configuration Location

By default, configs are loaded from `.devenv/config/` (one level up from `.infra/`).

Override the config directory location (in priority order):

1. **Pass `configDir` option** to `buildFullStackConfig()`
2. **Set `INFRA_CONFIG_DIR` environment variable** (absolute path)
3. **Use default**: `.devenv/config/` relative to project root

Example:

```bash
# Use a custom config directory
export INFRA_CONFIG_DIR=/path/to/custom/config
pnpm run synth
```

### `config/common.env`

Service ports, health check paths, and DB image versions shared across all environments:

```env
SERVICES__API__PORT=3000
SERVICES__API__HEALTH_CHECK=/api/health
SERVICES__WEB__PORT=4200
SERVICES__WEB__HEALTH_CHECK=/

DATABASES__MYSQL__PORT=3306
DATABASES__MYSQL__IMAGE=mariadb:10.11
```

### `config/env/{env}.env`

Everything that changes per environment — **two distinct concerns live in this one file**:

- **`APP_CONFIG__*`** → injected into all services as a Kubernetes `ConfigMap`
- **`APP_SECRETS__*`** → injected into backend services only as a Kubernetes `Secret`

```yaml
environment: local
namespace: local
domain: futbalio.local

appConfig:
  NODE_ENV: development
  LOG_LEVEL: debug
  CORS_ORIGINS: http://web.futbalio.local

appSecrets:
  JWT_SECRET_KEY: dev-jwt-secret-change-in-production
  KEYCLOAK_CLIENT_SECRET: your-client-secret

services:
  api:
    replicas: 1
    serviceType: NodePort
    nodePort: 30300
    imagePullPolicy: Always
    command: ["npm", "run", "start:debug"]
    debugPort: 9229
    debugNodePort: 30922
  web:
    replicas: 1
    serviceType: NodePort
    nodePort: 30420
    imagePullPolicy: Always
    command: ["pnpm", "run", "serve:ssr:futbalio-web"]
    env:
      API_URL: http://api.futbalio.local/api

databases:
  mysql:
    enabled: true
    credentials:
      database: futbalio
      username: futbalio_user
      password: futbalio_pass
  mongodb:
    enabled: true
    credentials:
      { database: futbalio_dev, username: futbalio, password: dev_pass }
  redis:
    enabled: true
    credentials: { password: redis_pass }

devtools:
  dbAdmin:
    enabled: true
    port: 8080

ingress:
  enabled: true
  className: traefik
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web
```

### `config/env/resources/{env}.yaml`

CPU/memory limits and storage sizes — kept separate so resource tuning never requires touching app config:

```yaml
services:
  api:
    resources:
      limits: { cpu: "500m", memory: "512Mi" }
      requests: { cpu: "100m", memory: "256Mi" }
  web:
    resources:
      limits: { cpu: "500m", memory: "1Gi" }
      requests: { cpu: "100m", memory: "256Mi" }
databases:
  mysql: { storageSize: "10Gi" }
  mongodb: { storageSize: "5Gi" }
  redis: { storageSize: "1Gi" }
```

---

## Building and synthesizing

```bash
cd .devenv/.infra
pnpm install

# Type-check only (no files emitted)
pnpm run build

# Synthesize Kubernetes YAML for a specific environment
pnpm run synth:local     # → APP_ENV=local
pnpm run synth:dev       # → APP_ENV=dev
pnpm run synth:staging   # → APP_ENV=staging  ⚠ config files not yet created
pnpm run synth:prod      # → APP_ENV=prod      ⚠ config files not yet created

# Or inline
APP_ENV=dev pnpm run synth
```

`APP_ENV` is the highest-priority override — it takes precedence over `build.Environment` and `build.defaultEnvironment` in `devenv.yaml`.

### Apply to cluster

```bash
APP_ENV=local pnpm run synth
kubectl apply -f dist/

# Or use the devenv convenience command
./devenv deploy
```

---

## Environment comparison

| Config             | `local`       | `dev`               |
| ------------------ | ------------- | ------------------- |
| Service type       | NodePort      | ClusterIP           |
| API replicas       | 1             | 2                   |
| Image pull policy  | Always        | Always              |
| API command        | `start:debug` | `node dist/main.js` |
| Debug port exposed | Yes (9229)    | No                  |
| Dev tools (WhoDB)  | Enabled       | Enabled             |
| Secrets source     | Inline YAML   | Inline YAML         |

---

## Reusing `src/lib/` in another project

`src/lib/` contains no Futbalio-specific code. To use it in a new project:

1. Copy `src/lib/` into the new project's `.infra/src/lib/`
2. Create a thin chart wrapper:

```typescript
// my-app-chart.ts
import { Construct } from "constructs";
import { FullStackChartProps, FullStackChart } from "./lib/charts/full-stack";

export class futbalioChart extends FullStackChart {
  constructor(scope: Construct, id: string, props: FullStackChartProps) {
    super(scope, id, props);
    // add app-specific constructs here only if needed
  }
}
```

3. Wire it up in `src/main.ts`:

```typescript
import { App } from "cdk8s";
import { futbalioChart } from "./my-app-chart";
import { buildFullStackConfig, loadDevEnvConfig } from "./lib/config/builder";

const devEnvConfig = loadDevEnvConfig();
const config = buildFullStackConfig(devEnvConfig, "my-app", {
  enableMongoDB: true,
  enableRedis: true,
});

const app = new App({ outdir: "dist" });
new futbalioChart(app, "app", { config });
app.synth();
```

4. Create `config/{env}.env` and `.infra/resources/{env}.yaml` following the schema above.

---

## Known improvements needed

These gaps exist today and should be addressed before using this in staging or production.

### Security

- **Inline secrets in YAML for local/dev** — `appSecrets` values are stored as plain text for `local` and `dev` environments. For staging and prod, set `secretsBackend=external-secrets` in your environment `.env` and configure `externalSecretStore.*` to point at your AWS Secrets Manager / Vault `ClusterSecretStore`. See `config/staging/.env` for an example.
- **TLS** — The ingress construct supports TLS via `INGRESS__TLS__SECRET_NAME`. Pair with a cert-manager `ClusterIssuer` annotation (see `config/staging/.env`) for automated certificate provisioning.

### Missing environments

- **`staging` and `prod` config files do not exist.** `config/staging.env`, `config/prod.env`, and their matching `.infra/resources/` files must be created before the `synth:staging` / `synth:prod` scripts are usable.

### Config system

- **`config/common.yaml` has `app.name: futbalio`** — this leftover placeholder should be updated to `futbalio` or removed (the actual app name is resolved from `devenv.yaml`).

### Testing and operations

- **No diff step** — the workflow applies directly with no `kubectl diff` against the live cluster, which is risky for dev and above.

---

## Manifest History and GitOps Strategy

`dist/` is gitignored by default so raw generated YAML never sits in the main branch.
Two patterns are supported — choose one per environment:

### Option A: GitOps with ArgoCD or Flux (recommended for staging / prod)

1. After every merged PR, CI runs `pnpm run synth:{env}` and commits the generated `dist/` to
   a **dedicated `infra-manifests` branch** (or a separate repository) with the commit SHA in the message.
2. ArgoCD or Flux watches that branch and applies changes to the cluster automatically.
3. You get full diff history, automated rollback (`git revert`), and PR-gated manifest reviews.

```bash
# CI step (simplified)
APP_ENV=staging pnpm run synth:staging
git add dist/
git commit -m "chore(infra): staging manifests @ $GITHUB_SHA"
git push origin infra-manifests
```

ArgoCD `Application` config example:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: futbalio-staging
spec:
  source:
    repoURL: https://github.com/your-org/groma
    targetRevision: infra-manifests
    path: dist/
  destination:
    server: https://kubernetes.default.svc
    namespace: futbalio-staging
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Option B: Direct CI apply (simpler, suitable for local / dev)

1. CI synthesizes and immediately applies:

```bash
APP_ENV=dev pnpm run synth:dev
kubectl apply -f dist/
kubectl rollout status deployment/api-deployment -n futbalio-dev
```

2. No manifest branch is required, but you lose diff history and rollback capability.
   Add `kubectl diff -f dist/` before `apply` to surface changes in the CI log.

### Prerequisites for staging / prod

| Prerequisite | Why |
|---|---|
| [cert-manager](https://cert-manager.io/docs/installation/) + a `ClusterIssuer` | Automatic TLS certificate provisioning via Let's Encrypt |
| [External Secrets Operator](https://external-secrets.io/latest/) + a `SecretStore` / `ClusterSecretStore` | Pull credentials from AWS Secrets Manager / Vault instead of embedding them in manifests |
| ArgoCD **or** Flux | GitOps-based reconciliation from the `infra-manifests` branch |

---

## Troubleshooting

**`Cannot find devenv.yaml`**
The builder resolves `devenv.yaml` relative to its own location at `../../../../devenv.yaml`. Run synth commands from inside `.devenv/.infra/`, not the project root.

**Missing required config value error**
Every field read by `builder.ts` is `required()`. The error message names the exact key that is missing — add it to the appropriate `config/{env}.env` or `.infra/resources/{env}.yaml`.

**`pnpm run synth` produces no output / empty `dist/`**
Verify `app.synth()` is the last line in `src/main.ts`.

**Kubernetes types out of date**
`src/lib/k8s.ts` is the committed canonical K8s API types file. Do not run `cdk8s import` — it overwrites this file. Add new API types manually or extend the existing ones.
