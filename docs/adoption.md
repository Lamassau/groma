# Adopting an existing application

This guide covers the migration-oriented features added after the Futbalio shared-Droplet adoption. The goal is to keep `schemaVersion: 1` compatible while reducing application changes and hand-written SSH/CI glue.

## Start from Docker Compose

```bash
groma init --from-compose docker-compose.yml --name my-app
```

The importer maps best-effort `image`, container ports, non-secret environment values, exec healthchecks, `depends_on`, named volumes, `mem_limit`, and `cpus`. It emits TODO comments where GROMa cannot safely decide public routes, secret handling, bind mounts, or persistent-vs-ephemeral intent.

It never copies `env_file` contents and never emits credential-looking environment values. Review every TODO, provision secrets separately, then run `groma validate`.

## Keep one public origin

Use `route.path` for same-host routing instead of creating an API subdomain solely for deployment reasons:

```yaml
services:
  web:
    image: example/web:dev
    port: 3000
    healthcheck: {http: /health}
    route: {domain: app.example.com, hostPort: 18080}
  api:
    image: example/api:dev
    port: 4000
    healthcheck: {http: /v1/health}
    route:
      domain: app.example.com
      path: /api
      rewritePrefix: /v1
      hostPort: 18081
```

Caddy chooses the longest path first, so the bare route cannot shadow `/api`. Kubernetes renders equivalent Ingress paths; nginx is required for rewrite/strip behavior.

## Inject file secrets into normal application env

```yaml
secrets:
  db-password:
    file: /opt/groma-secrets/my-app/db-password
services:
  api:
    secrets: [db-password]
    secretEnv:
      MYSQL_PASSWORD: db-password
```

Compose still mounts the secret as a file and exposes `MYSQL_PASSWORD_FILE`. During deployment GROMa adds an explicit release-local shim that reads the file before starting the original image ENTRYPOINT/CMD. Kubernetes uses `secretKeyRef` directly.

The Compose shim currently requires `/bin/sh`; distroless images fail closed rather than silently losing their original startup semantics. A plain `environment.MYSQL_PASSWORD` wins over the file, which is useful for local overrides.

Provision values with stdin only:

```bash
printf '%s' "$MYSQL_PASSWORD" | groma secret set db-password --stdin \
  --yes --expect-target deploy@dev.example.com
groma secret list
```

## Reduce repeated configuration

Use `defaults.environment` and `defaults.resources`. Overlay precedence is deliberately:

```text
base defaults < base service < overlay defaults < overlay service
```

The existing top-level `environment` remains the deployment environment name; reusing it for service environment variables would have broken schema v1.

## Pin production images without fake digests

Keep readable tags in the production overlay, then maintain an explicit lock:

```bash
groma pin --env production
groma validate --env production
groma pin --env production --check
```

The lock lives at `deploy/images.lock.yaml` relative to the base config. `plan` reports tag drift. CI `--image` digest overrides remain highest precedence.

## Adopt existing data

When migrating a database that already has a Docker volume:

```yaml
volumes:
  - name: data
    mount: /var/lib/mysql
    mode: persistent
    external: oldproject_database-data
```

GROMa references the external Docker volume and does not create or delete it. Without `external`, `plan` warns when it sees a likely same-logical-name volume from another Compose project.

## Incident and maintenance commands

```bash
# stream / filter logs
groma logs api --follow
groma logs api --since 2h --tail 500

# run against the current release; stdin/stdout are streamed
groma exec api -- npm run migration:status \
  --yes --expect-target deploy@dev.example.com

groma exec database -- mysqldump --single-transaction app \
  --yes --expect-target deploy@dev.example.com | gzip > app.sql.gz

# release history
groma releases
```

`exec` arguments are shell-quoted on the SSH hop; use `sh -c '...'` explicitly when you want expansion inside the container. Mutating commands retain `--yes --expect-target`.

## Adopt a shared host without re-provisioning it

For a host that already has Docker and Caddy:

```bash
groma host adopt > adopt.sh
# review it
groma host adopt --execute --yes --expect-target deploy@dev.example.com
```

`host adopt` only verifies Docker access, creates GROMa directories, adds the Caddy import when missing, validates Caddy, and reloads it. It does not install packages, change UFW, replace the existing Caddyfile, or change unrelated proxy routes.

## Reusable CI builds

The reusable workflow stays pinned to a reviewed 40-character GROMa commit SHA. Supply the same SHA as `groma-ref`; CI verifies it equals the toolkit checkout's actual `HEAD`. The npm package removes local clone/build scaffolding, while the reusable workflow keeps the duplicate SHA as an explicit safety check because a called workflow cannot reliably infer its own `uses:` ref from GitHub context.

Per-service build definitions additionally support:

```json
{
  "service": "web",
  "context": ".",
  "dockerfile": "Dockerfile",
  "target": "production",
  "buildArgs": {"PUBLIC_URL": "https://example.com"},
  "platforms": ["linux/amd64", "linux/arm64"],
  "secrets": ["NPM_TOKEN"]
}
```

Build arguments are non-secret and reject newlines. Secret IDs select values from the protected `BUILD_SECRETS` JSON workflow secret; values are written to temporary `0600` files and passed with BuildKit `secret-files`, never embedded in the services JSON.

Released versions publish `@lamassau/groma` to npm, so application repositories can use a reviewed version directly, for example:

```bash
pnpm dlx @lamassau/groma@1.4.2 validate
```

Publishing requires the GROMa repository's `NPM_TOKEN` secret and retains release-please as the version source.
