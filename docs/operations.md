# Operating GROMa applications

This release adds guided setup, public deployment verification, a host overview, digest-aware deployment previews, safe lifecycle/cleanup commands, and a reusable GitHub Actions workflow. None of these commands provision a DigitalOcean account or change DNS.

## Guided initialization

`groma init` launches a wizard in an interactive terminal. Use `--interactive` explicitly, or `--no-interactive` in scripts. JSON mode never starts prompts unless explicitly requested. Existing files are never overwritten.

The wizard asks for target, application/environment names, SSH host/port or Kubernetes context, service names and images, public/private routing, container/host ports, public health path, an exec healthcheck, and optional PostgreSQL/MySQL with persistent or ephemeral storage. It can add multiple services including workers without public routes.

It does not collect secret values. The MySQL preset uses separate application and root password files (the root file defaults to the application password path plus `.root`). Database presets reference files you provision on the host, or existing Kubernetes Secrets. Applications must be configured to connect to the selected database; GROMa cannot infer your app's environment variable names. For HTTP services you can use `healthcheck: {http: /health}`; Compose probes with wget/curl/node when available and Kubernetes emits native HTTP probes. Raw exec arrays remain supported. If a Compose HTTP probe cannot find a supported executable, deployment diagnostics name the service and explain the image requirement. An empty array in the wizard explicitly disables the container healthcheck.

A non-interactive example:

```bash
groma init --no-interactive --name demo \
  --host deploy@dev.example.com --image web=ghcr.io/example/demo:release \
  --port 3000 --domain demo.example.com --host-port 18080 \
  --health-path /health \
  --health-command '["node","healthcheck.js"]' \
  --database postgres --storage persistent
```

## Verify public reachability

```bash
groma verify --wait 120 --timeout 10 --min-cert-days 7
groma verify --json
```

Checks run from the machine invoking the CLI, not from inside the container. For every public route, GROMa:

1. Resolves both A and AAAA records. No records is an error.
2. For Compose, compares every advertised address with the SSH hostname's resolved addresses. Override with `route.expectedAddresses` when using an intentional proxy/CDN or a private SSH hostname. Kubernetes only checks ownership if expected addresses are supplied.
3. Connects to **each** advertised address over HTTPS while retaining the public hostname for SNI and certificate hostname validation. Untrusted, wrong-host or expired certificates fail; insecure TLS is never enabled.
4. Checks certificate remaining lifetime (default at least seven whole days).
5. Requests `route.healthPath` (default `/`) and requires `route.expectedStatus` (default `200`). Redirects are not followed and are not treated as a healthy endpoint.

```yaml
route:
  domain: demo.example.com
  hostPort: 18080
  healthPath: /health
  expectedStatus: 200
  # Optional explicit proxy/public addresses. All advertised DNS addresses must match.
  expectedAddresses: [203.0.113.10]
```

`--wait` is a retry window; a final in-progress network attempt may finish after it. `--timeout` limits each network request. Verification does not inspect response bodies, guarantee deployment identity from a 200 response, perform load testing, or check application-level business functionality.

`deploy` now performs public verification automatically after updating containers and Caddy. A verification failure returns a nonzero exit code and a report with `deployed: true`; the active release is **retained**. DNS propagation or ACME delays are not safe reasons to automatically reverse database-affecting application changes. Inspect and retry `verify`, or explicitly roll back. Non-production users can choose `--skip-verify`; production cannot. No-route applications report verification as skipped, while container health/readiness is still checked by deployment.

Rollback verifies the restored release's saved configuration. Releases from older GROMa versions without saved health metadata explicitly report verification skipped instead of testing the wrong configuration.

## See every managed app on a host

```bash
groma apps
groma apps --host deploy@dev.example.com --ssh-port 22
groma apps --json
```

The host form does not require a local groma.yaml. Output includes release IDs, URLs, actual running image references, container state/health, CPU and memory usage, host CPU/load, available memory and disk space. Stopped containers have no live resource sample. Apps with unreadable or invalid metadata are reported with errors rather than silently counted as healthy. Only GROMa-managed projects with an active release are listed; this is not an inventory of every unrelated Docker container.

Inventory never returns container environment variables or secret contents. Stats are a point-in-time observation and take a few seconds on hosts with several applications.

## Review changes before deployment

```bash
groma plan
groma plan --image web=ghcr.io/example/demo@sha256:YOUR_DIGEST --json
```

Compose plans compare the previous release's locked image references with the candidate configuration. When `deploy/images.lock.yaml` exists, `plan` also reports whether any recorded source tag has moved since `groma pin`. Use `groma pin --check` as a CI gate when production configuration intentionally keeps human-readable tags. Registry errors fail closed instead of guessing. Plans also warn when a new GROMa persistent volume appears to have a same-named predecessor from another Compose project, which is a common migration/data-loss signal.

Plans include added/removed/changed services, old/new image digests, changed field names, routing before/after, and storage/secret-reference risk flags. Environment and command **values** are never printed in the structured plan. Treat your config as non-secret anyway; applications may still log credentials elsewhere.

`deploy` always generates this plan and applies its exact locked image set. It checks that the active release has not changed between planning and acquiring the deployment lock; if it has, deployment stops and asks you to plan again. A separately run `plan` is a preview, not a persisted approval token; deploy recalculates it.

Service removals require `--allow-service-removal`. Changes to existing storage require `--allow-storage-change`. These flags supplement `--yes --expect-target`; they never authorize deleting volume data.

Plans compare saved release configuration, not arbitrary runtime changes made outside GROMa. Kubernetes retains `kubectl diff`; the detailed Compose plan format and storage acknowledgements do not apply to Kubernetes.

## Run one-off commands safely

`groma exec` runs against the current release rather than guessing a container name:

```bash
groma exec api --yes --expect-target deploy@dev.example.com -- npm run migrate
printf 'select 1;\n' | groma exec database --yes --expect-target deploy@dev.example.com -- psql -U demo
```

The command is passed as an argv vector and stdin/stdout remain attached, avoiding nested host/container command substitution. It is treated as a mutation and therefore requires the normal target confirmation.

## Provision and inspect secret files

Compose secret values are accepted only on stdin:

```bash
printf '%s' "$DB_PASSWORD" | groma secret set db-password --stdin --yes --expect-target deploy@dev.example.com
groma secret list
```

`secret set` never accepts a value in argv, never echoes it, writes atomically with mode `0400`, and uses the configured host path. `secret list` returns names, modes and modification times only. Kubernetes secrets remain provisioned through Kubernetes tooling/secret managers.

## Incident logs and release history

```bash
groma logs api --tail 500 --since 2h
groma logs api --follow --since 10m
groma releases
```

Log output may contain application secrets; the warning is intentional. `releases` reports release timestamps, recorded deployer, requested images and active/previous markers without returning environment or secret values.

## Stop and start without changing releases

```bash
groma stop --yes --expect-target deploy@dev.example.com
groma start --yes --expect-target deploy@dev.example.com
```

Both act on the **active saved release**, not an edited local Compose configuration. Stop retains containers and all named volumes. Ephemeral tmpfs storage is lost on stop, so GROMa refuses unless you also pass `--allow-ephemeral-loss`. Start uses existing containers and waits for health, without pulling images or recreating missing services; if containers were removed, use deploy instead.

Public routes remain configured during stop, so requests can receive a proxy error until the app starts again. Domain/port ownership stays reserved. These commands require Python 3 on the host, as does inventory/planning/pruning. New host setup installs it; install it manually on an older prepared host before upgrading.

## Prune old releases safely

```bash
groma prune --keep 5 --min-age-hours 24
# Review the candidates, then execute:
groma prune --keep 5 --min-age-hours 24 --execute --yes \
  --expect-target deploy@dev.example.com
```

The default is a preview. Keep is at least two and defaults to five newest validated release directories. The current release, previous release, and releases referenced by any existing project container are always protected, even if that exceeds keep. The minimum age defaults to 24 hours, protecting recent failed attempts while you diagnose them.

Pruning holds the same host-wide lock as deployment, checks project identity and release metadata, refuses escaping pointers, and skips unknown or symlink-containing directories. It deletes only validated release directories. It never invokes Docker volume/image/system pruning, deletes external secret files, or removes the application's project directory.

## Automation

See [GitHub Actions deployment](github-actions.md) for automatic dev builds and protected production deployment.
