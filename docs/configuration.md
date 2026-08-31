# Configuration reference

All configuration is runtime validated. The current version remains `schemaVersion: 1`; the additions below are backward-compatible. Service/application names start with a lowercase letter and contain at most 30 lowercase letters, digits or hyphens. Unknown fields fail validation.

## Profiles and production image locks

| Profile | Defaults and validation |
| --- | --- |
| local | One instance per service, 0.5 CPU / 256Mi unless overridden. |
| shared-dev | Same economical defaults; storage explicitly chooses persistent or ephemeral. |
| production | Every effective image must be an immutable `@sha256:` reference and every service needs a healthcheck. Kubernetes routes also require a TLS Secret. |

A production YAML may keep readable tags when they are pinned in `deploy/images.lock.yaml`:

```bash
groma pin --env production
groma validate --env production
groma pin --env production --check
```

The lock stores each service's source tag, resolved digest and resolution time. `validate` applies a matching lock before production digest validation. Explicit `--image service=image@sha256:...` overrides are applied last, so CI-built digests still win. `plan` reports when a locked tag resolves to a different digest; `pin --check` exits nonzero when a refresh is needed.

## Shared defaults and overlay precedence

The top-level `environment` field already means the **deployment environment name**, so schema v1 does not reuse it for service environment variables. Use additive `defaults` instead:

```yaml
schemaVersion: 1
name: demo
environment: dev
profile: shared-dev
target: compose

defaults:
  environment:
    NODE_ENV: production
    LOG_LEVEL: info
  resources:
    cpu: 0.5
    memory: 256Mi
```

Effective precedence is:

```text
base defaults < base service < overlay defaults < overlay service
```

Place overlays in `environments/<name>.yaml`. Objects merge, arrays replace, and `services.<name>: null` removes an inherited service. Missing overlays are errors.

## Routing: same-origin paths

Multiple services can share one hostname when their `(domain, path)` pairs differ:

```yaml
services:
  web:
    image: ghcr.io/example/web:dev
    port: 3000
    healthcheck: {http: /health}
    route:
      domain: app.example.com
      hostPort: 18080

  api:
    image: ghcr.io/example/api:dev
    port: 4000
    healthcheck: {http: /v1/health}
    route:
      domain: app.example.com
      path: /api
      rewritePrefix: /v1
      hostPort: 18081
```

Path routes are emitted before the bare-domain fallback. `stripPathPrefix: true` turns `/api/foo` into `/foo`; `rewritePrefix: /v1` turns it into `/v1/foo`. The two options are mutually exclusive and require a non-root `route.path`.

For Kubernetes, `route.path` renders an Ingress path. Path rewriting uses nginx Ingress rewrite annotations and therefore requires an nginx ingress class when an explicit class is configured. The public verifier prefixes a route-scoped health URL automatically, e.g. `path: /api` + `healthPath: /health` verifies `/api/health`.

## Healthchecks

Raw exec arrays remain supported:

```yaml
healthcheck: [node, healthcheck.js]
```

HTTP sugar is additive:

```yaml
port: 3000
healthcheck: {http: /v1/health/live}
```

Kubernetes renders a native `httpGet` probe. Compose renders a shell probe that tries `wget`, then `curl`, then `node`, and fails with an explicit requirement message if none exists. Raw exec arrays never gain an implicit shell. When a Compose deployment times out on health, GROMa identifies unhealthy services and prints the most recent health-check output; treat that output like application logs because it may contain sensitive text.

## Secrets and `secretEnv`

Secret values never belong in YAML or command-line arguments. Compose references existing host files; Kubernetes references existing Secret objects:

```yaml
secrets:
  db-password:
    file: /opt/groma-secrets/demo/db-password

services:
  api:
    image: ghcr.io/example/api:dev
    secrets: [db-password]
    secretEnv:
      MYSQL_PASSWORD: db-password
```

On Compose, GROMa also renders `MYSQL_PASSWORD_FILE=/run/secrets/db-password`. At deployment time it inspects the pulled image's ENTRYPOINT/CMD, mounts a release-local entrypoint shim, and preserves the original process arguments. The shim exports `MYSQL_PASSWORD` from the secret file before the application starts, strips trailing newlines, and fails loudly naming the variable when the file is unreadable or empty. If `MYSQL_PASSWORD` is explicitly set in `environment`, that plain value wins and the file is not read for that variable.

The current Compose shim requires `/bin/sh` in the application image. Distroless/scratch images fail closed with a clear message; for those images use native `*_FILE` support or Kubernetes until GROMa ships an architecture-specific static shim. Kubernetes does not use the shim: it renders `env.valueFrom.secretKeyRef` directly.

Provision configured Compose secret files without exposing values in shell history:

```bash
printf '%s' "$VALUE" | groma secret set db-password --stdin \
  --yes --expect-target deploy@host.example.com
groma secret list
```

`secret list` returns only names, file modes and modification times, never values.

## Volumes

Disposable storage:

```yaml
volumes:
  - name: cache
    mount: /cache
    mode: ephemeral
```

GROMa-managed persistent storage:

```yaml
volumes:
  - name: data
    mount: /var/lib/postgresql/data
    mode: persistent
```

Adopt an existing Docker named volume in place:

```yaml
volumes:
  - name: data
    mount: /var/lib/postgresql/data
    mode: persistent
    external: legacy_project_db_data
```

`external` is Compose-only and never creates/deletes the referenced volume. `plan` warns when a new GROMa-managed persistent volume would be created while another project appears to have a same-logical-name volume, so migrations do not silently start against empty storage.

Persistent Kubernetes volumes additionally require `size: 5Gi` and optionally `kubernetes.storageClass`.

## Targets and command support

Compose host settings: `ssh: user@hostname` (or IPv4), optional `port` (default 22). SSH uses `StrictHostKeyChecking=yes` and `BatchMode=yes`.

Kubernetes settings: explicit `context`, optional `ingressClass`, `tlsSecret`, `storageClass`. GROMa does not install Kubernetes, an ingress controller, cert-manager or CRDs.

`apps`, `start`, `stop`, `prune`, `releases`, `secret set/list`, `host setup`, and `host adopt` are Compose-only. `status`, `logs`, `exec`, `plan`, `deploy`, `verify`, and `rollback` support their documented target behavior. Mutating target operations retain the `--yes --expect-target ...` guard.

See [Adopting an existing application](adoption.md) and [operations](operations.md) for migration and operational commands.
