# Reusable GitHub Actions deployment

`.github/workflows/deploy.yml` is a reusable **Compose/droplet** workflow. It validates configuration and build inputs, builds one or several services, pushes images to GHCR, downloads immutable digest records in the deploy job, and invokes GROMa with `--image` overrides. Public DNS/TLS/health verification remains mandatory.

The workflow is callable only. It does not provision cloud resources, secrets, DNS, repository settings, or environment protection.

## Pin the reusable workflow

Call the workflow by a reviewed full commit SHA:

```yaml
jobs:
  deploy:
    uses: Lamassau/groma/.github/workflows/deploy.yml@REVIEWED_40_CHARACTER_SHA
    with:
      environment: dev
      expected-target: deploy@dev.example.com
      groma-ref: REVIEWED_40_CHARACTER_SHA
      config-path: groma.yaml
```

Set `groma-ref` to the same reviewed 40-character SHA used in `uses:`. The workflow checks that the toolkit checkout's actual `HEAD` equals `groma-ref`, so a mismatched pair fails before build or deploy. GitHub does not expose a trustworthy reusable-workflow self-ref inside the called workflow, so GROMa deliberately keeps this duplicate pin rather than infer the caller's workflow ref incorrectly.

## One-time prerequisites

1. Prepare the target host and a separately verified SSH host key.
2. Commit `groma.yaml`, Dockerfiles and environment overlays.
3. Create a GitHub deployment environment named `dev`, `staging` or `production`.
4. Put `SSH_PRIVATE_KEY` and `SSH_KNOWN_HOSTS` in that environment. Do not generate trusted host keys blindly inside the workflow.
5. For production, configure **required reviewers**, **prevent self-review**, branch restrictions and protected workflow/config branches. GROMa checks reviewer policy before builds and again before deployment and fails closed if the policy cannot be verified.
6. Permit the caller `contents: read`, `actions: read` and `packages: write`; configure GHCR package access. The target host needs independent pull access for private images.

## Build definitions

The `services` input is a JSON array. Each build definition may include `service`, `context`, `dockerfile`, `target`, `buildArgs`, `platforms` and `secrets`:

```yaml
services: >-
  [{"service":"api","context":".","dockerfile":"api/Dockerfile",
    "target":"production","buildArgs":{"NODE_ENV":"production"},
    "platforms":["linux/amd64","linux/arm64"],"secrets":["npmrc"]},
   {"service":"web","context":".","dockerfile":"web/Dockerfile","target":"production"}]
```

Contexts and Dockerfiles must remain inside the checked-out application repository. Targets, build-argument names and platform values are validated before the build starts.

Build-secret **values do not belong in the services JSON**. If a definition requests secret IDs, map the values through the reusable workflow secret `BUILD_SECRETS` as a JSON object, for example `{"npmrc":"..."}` from an environment/repository secret. The workflow writes only requested values to temporary `0600` files, passes them to BuildKit using `secret-files`, and removes the files in an `always()` cleanup step. Missing requested IDs fail the build.

QEMU/Buildx are configured so multi-platform builds can be requested explicitly. Omit `platforms` to retain the runner/default-platform behavior.

## Production image validation

The build job records `service -> image@sha256:...` artifacts. Deployment supplies those digests with `--image`, which takes precedence over a local `deploy/images.lock.yaml`. This means the reusable CI workflow can deploy freshly built production images while developers can still validate a committed production overlay locally with `groma pin`.

Prebuilt dependencies that are not built by the workflow must already satisfy the effective production configuration, either through immutable image references or the checked-in GROMa image lock.

## Automatic dev and protected production

Copy [the dev caller example](../examples/workflows/deploy-dev.yml) for push-to-main development deployments. Copy [the production caller](../examples/workflows/deploy-production.yml) for manual production dispatch. Production deployment still runs in the protected GitHub environment and requires the configured independent reviewer policy.

Deployments to the same caller target/config/environment are serialized and are not canceled in progress. The host-wide GROMa lock adds coordination across applications and repositories. SSH key material is kept in a temporary private directory, supplied through a dedicated OpenSSH config, removed from the child environment and deleted afterward.

## Failure behavior

- Invalid build paths/targets/arguments/platforms/secrets fail before image build.
- A missing production reviewer policy fails closed.
- A failed image resolution or deployment plan prevents deployment.
- Service removals and storage changes still require an explicit reviewed local deployment; CI does not grant those override flags.
- Public verification failure makes the job fail while retaining the new active release for diagnosis.

Unit tests cover the workflow contract, but GHCR, GitHub environment gates, SSH and the actual target host remain external acceptance concerns.
