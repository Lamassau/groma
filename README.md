# GROMa

Deploy containerized applications to a **plain Linux server with Docker Compose**, or to an existing **Kubernetes cluster**. DigitalOcean droplets do not need Kubernetes for the Compose target.

GROMa provides a versioned application schema, an installable CLI, CDK8s library exports, validation, manifest generation, SSH deployment, HTTPS routing, and release recovery. It does not create cloud servers, build/push application images, register domains, or manage your DNS account.

## Quick start

Requirements on your workstation: Node.js 20+, pnpm 10.30.3, and OpenSSH. Docker is needed on the target server, not your workstation. Kubernetes commands require local `kubectl`.

From this repository:

```bash
pnpm install --frozen-lockfile
pnpm run compile
node build/cli.js init --name my-app
```

Edit `groma.yaml`: set the actual SSH target, application image, container port, healthcheck, domain and an unused loopback host port. The generated example is an Nginx demonstration, not your product's image.

```bash
node build/cli.js validate
node build/cli.js synth
node build/cli.js host setup > host-setup.sh
```

Review the setup script. The optional execution mode changes the host, installs software, configures Caddy, grants Docker group membership, and enables UFW. Use it only on a suitable Ubuntu 22.04/24.04 LTS server:

```bash
node build/cli.js host setup --execute --yes --expect-target deploy@your-droplet.example.com
```

The SSH account must already exist, have a verified host key in `known_hosts`, and be able to run passwordless sudo. GROMa never creates users, disables host-key verification, or modifies SSH authentication. See [host setup and security](docs/compose-deployment.md) before running this command.

Point the domain's DNS A record at your droplet. Set an AAAA record only if IPv6 is configured correctly. Allow TCP 80/443 through the DigitalOcean firewall, and allow your configured SSH port from your administration addresses.

```bash
node build/cli.js doctor
node build/cli.js plan
node build/cli.js deploy --yes --expect-target deploy@your-droplet.example.com
node build/cli.js status
node build/cli.js logs web
```

Caddy provisions and renews HTTPS certificates when DNS and network access are correct. A successful deployment means Compose services passed running/health checks and Caddy accepted the configuration; it does **not** certify public DNS, certificate issuance, or external reachability. Verify the public URL after deployment.

## Configuration

```yaml
schemaVersion: 1
name: my-app
environment: dev
profile: shared-dev
target: compose
host:
  ssh: deploy@your-droplet.example.com
services:
  web:
    image: ghcr.io/your-org/my-app:your-release
    port: 3000
    healthcheck: [node, -e, "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    route:
      domain: dev.example.com
      hostPort: 18080
    resources:
      cpu: 0.5
      memory: 256Mi
```

Only services declaring a route publish a port, bound to `127.0.0.1`. Caddy runs on the host and forwards requests to these loopback ports. Every app/environment has its own Compose project, network and named volumes. Databases stay on the application's network. All projects still share one host and failure domain; this is not a security boundary against a hostile workload.

- `command`: argument array overriding the image CMD; image ENTRYPOINT remains intact.
- `environment`: **non-sensitive strings**; `$` characters are preserved literally in Compose. Do not put secrets here.
- `healthcheck`: executable argument array available inside the image; no implicit shell. Use `sh -c` explicitly if necessary. Without a check, Compose can only verify that a container is running.
- `dependsOn`: Compose-only list; referenced services must have healthchecks. Dependency cycles are rejected.
- `secrets`: selected references mounted at `/run/secrets/<name>`; see the [configuration reference](docs/configuration.md).
- `volumes`: explicit `persistent` or `ephemeral` mode. Persistent volumes are never deleted by deployment or rollback.
- Unknown settings, unsupported target options and malformed values fail validation instead of being silently ignored.

See [examples/compose](examples/compose), [examples/kubernetes](examples/kubernetes), and [configuration reference](docs/configuration.md).

## Commands

| Command | Behavior |
| --- | --- |
| `init` | Create a starter without overwriting an existing file. |
| `validate` | Offline schema and consistency checks. |
| `synth` | Generate manifests without accessing a target. |
| `doctor` | Check target access and core runtime prerequisites. |
| `plan` | Read-only Compose configuration diff or live `kubectl diff`. |
| `deploy` | Explicit target confirmation, apply and wait for health/readiness. |
| `status` | Inspect the active application's services. |
| `logs [service]` | Last 100 lines. Application logs may contain sensitive data. |
| `rollback` | Compose only: restore the previous release's configuration and locked image digests. Does not revert databases or secret file contents. |
| `host setup` | Print an Ubuntu setup script; remote execution requires `--execute --yes --expect-target`. |

Common options: `--config PATH`, `--env NAME`, `--out PATH`, `--json`. `--json` wraps command output in one object for automation (except the intentionally textual `init`, help and host setup commands).

`--env staging` requires `environments/staging.yaml` alongside your base config. Objects merge recursively; arrays replace. No overlay is guessed. The environment name and resource profile are separate, so staging can use `shared-dev`.

## Kubernetes and existing users

```bash
node build/cli.js init --target kubernetes --name my-app --config groma-k8s.yaml
node build/cli.js validate --config groma-k8s.yaml
```

Set `kubernetes.context`, optional ingress class/TLS secret, and service images. The CLI generates CDK8s API objects for arbitrary services, optional PVCs, existing Secret mounts and standard Ingress. It never installs controllers or a cluster. Kubernetes does not support Compose startup ordering; services must retry dependency connections. Kubernetes apply does not prune removed resources automatically.

The existing `FullStackChart`, database/cache/backup constructs and `.devenv` builder remain exported. Their `pnpm synth:*` commands retain the legacy layout. See [migration notes](docs/migration.md); these legacy constructs and the new generic renderer have different feature sets. The new generic renderer does not implicitly enable legacy autoscaling or backup jobs.

## Distribution and verification

```bash
pnpm run build
pnpm test --runInBand
pnpm run compile
pnpm pack
# Install the resulting .tgz in another project, or globally:
npm install -g ./lamassau-groma-0.1.0.tgz
groma --help
```

The package remains private to prevent accidental registry publication; a local/release tarball is installable without copying source files. Releases attach the package and complete, non-secret example manifests.

CI checks TypeScript, regression tests, example synthesis, package contents, and starts two disposable Compose projects. Run `pnpm run test:integration` only with a disposable local Docker daemon; it never uses SSH. Local shell transaction tests simulate Docker/Caddy and are not a substitute for a live droplet acceptance test.

## Scope

The Compose path is intended first for low-cost shared dev/staging. Production profile adds digest and healthcheck requirements; it does not make a single host highly available, provision off-host backups, verify restores, or install monitoring. Schedule and verify database backups separately before storing production data. There is no automatic database migration or data rollback. Updates may briefly interrupt service.
