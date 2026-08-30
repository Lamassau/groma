# Reusable GitHub Actions deployment

`.github/workflows/deploy.yml` is a reusable **Compose/droplet** workflow. It validates configuration and build inputs, builds one or several services, pushes images to GHCR, downloads the resulting digest records in the deploy job, and invokes GROMa with immutable image overrides. Public DNS/TLS/health verification is mandatory in this workflow.

This workflow is callable only; adding it to GROMa does not deploy any application. It accepts calls originating from push or workflow_dispatch, never from pull-request events. No cloud access, secrets or repository settings are provisioned by committing this file.

## One-time prerequisites in the application repository

1. Prepare the target host and a verified SSH host key; install Python 3 on older prepared hosts.
2. Commit your app's groma.yaml, Dockerfile(s), and any environment overlays. The app must expose its health endpoint and include its container healthcheck executable.
3. Create a GitHub deployment environment named `dev`, `staging`, or `production`.
4. Put `SSH_PRIVATE_KEY` and `SSH_KNOWN_HOSTS` in that environment. Obtain known_hosts from a separately verified host key, not a blind ssh-keyscan in CI. Custom SSH ports need OpenSSH's `[host]:port` known_hosts form.
5. For production, configure **required reviewers**, **prevent self-review**, appropriate deployment branch restrictions, and protect the workflow/config branches. The workflow checks reviewer policy before builds and again before deployment; missing policy or API access fails closed. Environment features depend on your GitHub plan/repository visibility. If your repository cannot enforce reviewers, this workflow deliberately refuses production.
6. Permit the caller workflow `contents: read`, `actions: read`, and `packages: write`. Configure GHCR package access for the repository. The deploy account on the droplet needs independent read access to private GHCR images; its Docker credentials are not sent from CI.
7. Select a reviewed full GROMa commit SHA containing the reusable workflow and use that same SHA for both the `uses` ref and `groma-ref`. No unpinned install script or moving GROMa branch is fetched.

The workflow never changes repository protections or grants permissions. Environment secrets are consumed by the reusable workflow's environment-bound deploy job. Alternatively caller-mapped secrets are supported, but **production SSH credentials should live in the protected production environment**, not broad repository secrets.

## Automatic dev deployment

Copy [the dev caller example](../examples/workflows/deploy-dev.yml) into the application's `.github/workflows/deploy-dev.yml`. Replace the SHA and target. Every push to main builds and deploys dev. No required reviewers on dev means no manual gate.

Inputs:

| Input | Meaning |
| --- | --- |
| `environment` | GitHub deployment environment: dev, staging or production. |
| `expected-target` | Exact user@host in the effective config. |
| `groma-ref` | Full reviewed GROMa commit SHA. |
| `config-path` | Application-relative base config, default groma.yaml. |
| `overlay` | Optional environments/NAME.yaml selection; empty uses the base config. |
| `services` | JSON build definitions with service, context and dockerfile. Defaults to web from ./Dockerfile. |

For two images:

```yaml
services: >-
  [{"service":"api","context":".","dockerfile":"api/Dockerfile"},
   {"service":"web","context":".","dockerfile":"web/Dockerfile"}]
```

Services must already exist in groma.yaml. The workflow builds tags such as `ghcr.io/owner/repository-api:<commit>`, then deploys `ghcr.io/owner/repository-api@sha256:...`. Prebuilt dependencies such as a database are omitted from the build definitions and keep their configured images. Production still requires digests for those dependencies.

Build contexts and Dockerfiles must stay inside the checked-out app repository. The workflow supports one Dockerfile build per service and the runner's default Linux architecture. ARM droplets, custom build arguments/secrets or multi-platform builds require a reviewed extension; don't assume an amd64 image runs on ARM.

## Protected production

Copy [the production caller](../examples/workflows/deploy-production.yml). Its manual dispatch starts a build; the deploy job then waits for the production environment's independent approval. All services in the effective config must meet production validation. `profile: production` cannot be deployed through dev/staging, and a production workflow cannot deploy a non-production profile.

Both jobs can run from trusted application code, so restrict who can modify callers and toolkit refs. The workflow is not a boundary against repository administrators who can edit environment protection.

Deployments to the same caller target/config/environment are serialized; in-progress deployments are not canceled. The host-wide GROMa lock provides additional coordination across applications and repositories. SSH keys are written to a temporary 0700 directory with 0600 files, supplied through a dedicated OpenSSH config, omitted from the child process environment, and removed in a finally block. Registry write credentials are used only in build jobs and are never transmitted to the droplet.

## Review failures

- A failed plan or image resolution prevents deployment.
- Service removals and storage changes require an explicit local reviewed deployment; the automated workflow does not grant those override flags.
- A public verification failure makes the job fail while keeping the new active release. Inspect the report and retry `groma verify`; rollback is an explicit operation.
- Changing the app's database schema is outside this workflow. Use backward-compatible migrations and tested backups before production.

You can test the workflow's structure and policy helpers locally, but its actual build, GHCR push, environment gate and SSH deployment require the configured application repository and host. Unit tests do not certify these external settings.
