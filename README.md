# GROMa

GROMa is a deployment toolkit for containerized applications.

It gives you one application definition — `groma.yaml` — and can deploy it to either:

- **a normal Linux server with Docker Compose**, or
- **an existing Kubernetes cluster**.

For a DigitalOcean Droplet, **you do not need Kubernetes**.

If you are deploying development, staging, demos, or several small applications to one inexpensive server, start with the **Compose target**.

> GROMa deploys applications. It does not create cloud servers, register domains, change DNS records, or provision managed databases.

---

## Choose your deployment target

| Your situation | Use |
| --- | --- |
| One low-cost DigitalOcean Droplet | **Compose** |
| Several dev/staging apps sharing one server | **Compose** |
| Demo / proof of concept | **Compose** |
| You already operate Kubernetes | **Kubernetes** |
| You need Kubernetes replicas or scheduling | **Kubernetes** |
| You need custom CRDs, HPA/PDB/network-policy constructs | **GROMa CDK8s library** |

**Not sure? Use Compose.**

---

## What GROMa manages

### Compose target

GROMa can:

- validate your deployment configuration;
- generate Docker Compose and Caddy configuration;
- prepare a supported Ubuntu host;
- check remote prerequisites;
- preview deployment changes;
- deploy over SSH;
- lock image tags to immutable digests;
- configure HTTPS with Caddy;
- verify DNS, TLS, and application health;
- show all GROMa-managed apps on a shared host;
- start, stop, inspect, prune, and roll back releases.

### Kubernetes target

GROMa can generate and apply standard:

- Deployments;
- Services;
- Ingress resources;
- persistent volume claims.

GROMa does **not** install Kubernetes, an ingress controller, cert-manager, cloud infrastructure, or CRDs.

---

# Quick start: deploy to a Linux server

This is the recommended starting point for a new user.

## 1. Requirements

### Workstation

- Node.js 20+
- pnpm 10.30.3
- OpenSSH

### Target server

Use Ubuntu **22.04 LTS** or **24.04 LTS**.

Before GROMa can connect, you need an SSH account that:

- already exists;
- uses SSH-key authentication;
- has a verified host key in your local `known_hosts`;
- can run passwordless `sudo` during initial host setup.

GROMa never disables SSH host-key checking and never creates SSH users.

---

## 2. Build the GROMa CLI

From the GROMa repository:

```bash
pnpm install --frozen-lockfile
pnpm run compile
node build/cli.js --help
```

When packaged or installed globally, the same CLI is available as:

```bash
groma --help
```

---

## 3. Create `groma.yaml`

You can use the guided initializer:

```bash
node build/cli.js init --name my-app
```

Or create the file yourself:

```yaml
schemaVersion: 1
name: my-app
environment: dev
profile: shared-dev
target: compose

host:
  ssh: deploy@dev.example.com

services:
  web:
    image: ghcr.io/your-org/my-app:latest
    port: 3000

    healthcheck:
      - node
      - -e
      - "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

    route:
      domain: my-app-dev.example.com
      hostPort: 18080

    resources:
      cpu: 0.5
      memory: 256Mi
```

Replace the example values with your real application settings.

### The four values new users most often get wrong

**`image`**
The container image to deploy. GROMa does not build this image during a normal CLI deployment.

**`port`**
The port your application listens on **inside the container**.

**`healthcheck`**
A command executed **inside the container**. Every executable in the command must exist in the image.

**`route.hostPort`**
A unique loopback port used between Caddy and the container. It is not exposed publicly.

Only services with a `route` are publicly reachable.

---

## 4. Validate locally

Before touching the server:

```bash
node build/cli.js validate --config groma.yaml
node build/cli.js synth --config groma.yaml
```

`validate` checks the schema and consistency.

`synth` generates the underlying Compose/Caddy or Kubernetes manifests so you can inspect them.

---

## 5. Prepare the server

First generate the setup script without changing anything:

```bash
node build/cli.js host setup --config groma.yaml > host-setup.sh
```

Review `host-setup.sh`.

To execute the reviewed setup remotely:

```bash
node build/cli.js host setup \
  --config groma.yaml \
  --execute \
  --yes \
  --expect-target deploy@dev.example.com
```

Host setup can install and configure:

- Docker Engine;
- Docker Compose;
- Caddy;
- Python 3;
- GROMa directories;
- UFW rules for SSH, HTTP, and HTTPS.

Use this on a new or dedicated server. Read [Plain-host / DigitalOcean deployment](docs/compose-deployment.md) before running it on an existing multi-purpose host.

---

## 6. Configure DNS

GROMa does not modify DNS.

Create an **A record** for the public application hostname:

```text
my-app-dev.example.com -> YOUR_DROPLET_IPV4
```

Only create an AAAA record when IPv6 is configured correctly.

Allow inbound traffic to:

- your SSH port;
- TCP 80;
- TCP 443.

Caddy obtains and renews HTTPS certificates after public DNS points to the server.

---

## 7. Check the server

```bash
node build/cli.js doctor --config groma.yaml
```

Fix any reported problem before deploying.

---

## 8. Preview the deployment

```bash
node build/cli.js plan --config groma.yaml
```

`plan` is read-only.

For Compose deployments it resolves candidate image digests and compares the proposed release with the currently active successful release.

---

## 9. Deploy

```bash
node build/cli.js deploy \
  --config groma.yaml \
  --yes \
  --expect-target deploy@dev.example.com
```

GROMa will:

1. validate the configuration;
2. check the host;
3. resolve images to immutable digests;
4. create a release directory;
5. pull images;
6. start containers;
7. wait for health checks;
8. configure the Caddy route;
9. make the release active;
10. verify public DNS, HTTPS, certificate validity, and the configured health URL.

A public verification failure returns a failure status but keeps the deployed release active. This avoids automatically reversing an application after a temporary DNS or ACME delay.

---

## 10. Inspect and operate the app

```bash
node build/cli.js status --config groma.yaml
node build/cli.js logs web --config groma.yaml
node build/cli.js verify --config groma.yaml
```

See every GROMa-managed app on a shared host:

```bash
node build/cli.js apps --host deploy@dev.example.com
```

---

# Common commands

| Command | Purpose |
| --- | --- |
| `groma init` | Create a starter configuration or guided project. |
| `groma validate` | Validate configuration locally. |
| `groma synth` | Generate deployment manifests locally. |
| `groma doctor` | Check remote prerequisites. |
| `groma plan` | Preview deployment changes. |
| `groma deploy` | Deploy the application. |
| `groma verify` | Re-check public DNS, TLS, and health. |
| `groma status` | Inspect the active application. |
| `groma logs [service]` | Show the last 100 log lines. |
| `groma apps` | List GROMa-managed apps on a Compose host. |
| `groma stop` | Stop the active Compose release without deleting persistent volumes. |
| `groma start` | Start the existing active Compose release. |
| `groma rollback` | Restore the previous release. |
| `groma prune` | Preview or remove old release directories. |
| `groma host setup` | Generate or execute Ubuntu host setup. |

Mutating commands require explicit target confirmation:

```bash
--yes --expect-target deploy@dev.example.com
```

That guard helps prevent accidental changes to the wrong server or Kubernetes context.

---

# Environment overlays

Keep a base `groma.yaml`, then add environment-specific changes under:

```text
environments/
  staging.yaml
  production.yaml
```

Example:

```yaml
# environments/staging.yaml
profile: shared-dev

host:
  ssh: deploy@staging.example.com

services:
  web:
    route:
      domain: staging.example.com
      hostPort: 18081
```

Use it with:

```bash
groma validate --env staging
groma plan --env staging
groma deploy --env staging \
  --yes \
  --expect-target deploy@staging.example.com
```

Objects merge recursively. Arrays replace the base array.

To remove a service in an overlay:

```yaml
services:
  worker: null
```

See [Configuration reference](docs/configuration.md).

---

# Secrets

Do **not** put passwords, API keys, SSH keys, or other secret values in `groma.yaml`.

For Compose, GROMa references an existing secret file on the host:

```yaml
secrets:
  db-password:
    file: /opt/groma-secrets/my-app/db-password

services:
  database:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db-password
    secrets:
      - db-password
```

The file must already exist on the server.

For Kubernetes, GROMa references an existing Kubernetes Secret.

See [Secrets and databases](docs/configuration.md#secrets-and-databases).

---

# Persistent and disposable data

Persistent volume:

```yaml
volumes:
  - name: data
    mount: /var/lib/postgresql/data
    mode: persistent
```

Disposable dev/test volume:

```yaml
volumes:
  - name: data
    mount: /tmp/data
    mode: ephemeral
```

Persistent Compose named volumes are not deleted during deployment or rollback.

GROMa does **not** roll back database contents or database migrations. Use backward-compatible migrations and a separate, tested backup/restore process.

---

# Kubernetes quick start

Use this path only when you already have a Kubernetes cluster and working `kubectl` access.

```bash
groma init \
  --target kubernetes \
  --name my-app \
  --config groma-k8s.yaml
```

Example:

```yaml
schemaVersion: 1
name: my-app
environment: dev
profile: shared-dev
target: kubernetes

kubernetes:
  context: my-cluster
  ingressClass: nginx

services:
  web:
    image: ghcr.io/your-org/my-app:latest
    replicas: 2
    port: 3000
    healthcheck:
      - node
      - healthcheck.js
    route:
      domain: dev.example.com
```

Then:

```bash
groma validate --config groma-k8s.yaml
groma doctor --config groma-k8s.yaml
groma plan --config groma-k8s.yaml
groma deploy \
  --config groma-k8s.yaml \
  --yes \
  --expect-target my-cluster
```

---

# GitHub Actions deployment

GROMa includes a reusable GitHub Actions workflow for Compose/Droplet deployments.

It can:

- build application images;
- push them to GHCR;
- deploy immutable digests;
- use GitHub deployment environments;
- enforce protected production approval;
- run GROMa deployment verification.

See [GitHub Actions deployment](docs/github-actions.md).

---

# Production expectations

The `production` profile adds stricter validation, including immutable image digests and health checks.

It does **not** make a single server highly available.

A single-host deployment still has one host failure domain. GROMa does not automatically provide:

- multi-node high availability;
- off-host database backups;
- restore testing;
- monitoring or alerting;
- managed databases;
- automatic DNS management;
- zero-downtime database migrations.

Compose is especially useful for economical dev/staging and smaller workloads. Add appropriate infrastructure when production reliability requirements demand it.

---

# Documentation

Start here and then move to the focused guide you need:

- [Documentation index](docs/README.md)
- [Plain-host / DigitalOcean deployment](docs/compose-deployment.md)
- [Configuration reference](docs/configuration.md)
- [Operations](docs/operations.md)
- [GitHub Actions deployment](docs/github-actions.md)
- [Migration from the original `.infra` layout](docs/migration.md)
- [Compose examples](examples/compose)
- [Kubernetes examples](examples/kubernetes)

---

# Legacy CDK8s library

Existing users can continue using `FullStackChart`, related constructs, and the original `.devenv` workflow.

For new projects, prefer the `groma.yaml` CLI workflow unless you specifically need the advanced Kubernetes constructs exposed by the library.

See [Migration](docs/migration.md).
