# Configuration Readme

This directory contains environment-specific Kubernetes configurations for the futbalio application.

## Structure

```
config/                          # Application configuration (.env format)
├── common.env                   # Base settings for all environments
├── local.env                    # Local development environment
├── dev.env                      # Shared development environment
├── staging.env                  # Staging/pre-production environment
└── prod.env                     # Production environment

.infra/resources/                # Resource sizing (YAML format)
├── local.yaml                   # Local resource limits
├── dev.yaml                     # Dev resource limits
├── staging.yaml                 # Staging resource limits
└── prod.yaml                    # Production resource limits
```

## Configuration Merging

Configurations are merged in this order (later values override earlier):

1. **`config/common.env`** - Base configuration shared by all environments
2. **`config/{env}.env`** - Environment-specific overrides
3. **`.infra/resources/{env}.yaml`** - Resource sizing (CPU, memory, storage)

### Example

If you define in `common.env`:

```env
SERVICES__API__PORT=3000
SERVICES__API__HEALTH_CHECK=/health
```

And then override in `env/local.env`:

```env
SERVICES__API__PORT=3001
```

The final configuration for local will use port `3001` but keep the `/health` health check path.

## .env File Format

Configuration files use a flattened key format with double underscores (`__`) to represent nesting:

```env
# Top-level settings
ENVIRONMENT=local
NAMESPACE=local
DOMAIN=futbalio.local

# Nested app config (becomes appConfig.NODE_ENV)
APP_CONFIG__NODE_ENV=development
APP_CONFIG__LOG_LEVEL=debug

# Service configuration (becomes services.api.replicas)
SERVICES__API__REPLICAS=1
SERVICES__API__COMMAND=pnpm,run,start:prod

# Database credentials (becomes databases.mysql.credentials.password)
DATABASES__MYSQL__CREDENTIALS__PASSWORD=localdev
```

## Environment Selection

The environment is selected via the `APP_ENV` environment variable:

```bash
# Local (default if not specified)
pnpm run synth
# or explicitly:
APP_ENV=local pnpm run synth

# Development
APP_ENV=dev pnpm run synth

# Staging
APP_ENV=staging pnpm run synth

# Production
APP_ENV=prod pnpm run synth
```

## Adding Configuration

### 1. Add to Common Config

For settings shared across all environments, add to `common.env`:

```env
    cpu: "250m"
    memory: "512Mi"
```

### 2. Add Environment-Specific Settings

In each environment file (e.g., `futbalio.local.yaml`), add:

```yaml
services:
  worker:
    replicas: 1
    serviceType: ClusterIP
    env:
      NODE_ENV: development # Override for local
```

### 3. Synthesize

```bash
pnpm run synth
```

The CDK8s code will automatically pick up the new service configuration.

## Environment-Specific Settings

### Local (`futbalio.local.yaml`)

- **Purpose**: Individual developer machines
- **Features**: Debug mode, NodePort services, dev tools enabled
- **Resources**: Minimal (100-500m CPU, 256Mi-1Gi RAM)
- **Replicas**: 1 per service
- **Secrets**: Inline (not secure, for convenience)

### Dev (`futbalio.dev.yaml`)

- **Purpose**: Shared development cluster for team
- **Features**: Always pull images, dev tools enabled
- **Resources**: Medium (250-1000m CPU, 512Mi-2Gi RAM)
- **Replicas**: 1-2 per service
- **Secrets**: From cluster secrets

### Staging (`futbalio.staging.yaml`)

- **Purpose**: Pre-production testing
- **Features**: Production-like, no dev tools
- **Resources**: High (500-2000m CPU, 1-4Gi RAM)
- **Replicas**: 2-3 per service
- **Secrets**: From external secret manager (AWS Secrets Manager, Vault)
- **TLS**: Enabled with Let's Encrypt staging

### Production (`futbalio.prod.yaml`)

- **Purpose**: Live production environment
- **Features**: No dev tools, managed databases, autoscaling
- **Resources**: Very high (1000-4000m CPU, 2-8Gi RAM)
- **Replicas**: 3+ per service (with autoscaling)
- **Secrets**: From external secret manager
- **TLS**: Enabled with Let's Encrypt production
- **Monitoring**: Full observability stack

## Security Best Practices

### 🚨 Never Commit Real Secrets

The provided YAML files contain **placeholder passwords** like:

- `dev_password_change_me`
- `${SECRET_MYSQL_PASSWORD}`
- `${RDS_ENDPOINT}`

### For Local Development

It's acceptable to use simple passwords in `futbalio.local.yaml` since it only runs on your machine.

### For Shared Environments (Dev, Staging, Prod)

1. **Use placeholders** in YAML files: `${SECRET_NAME}`
2. **Store actual secrets** in:
   - Kubernetes Secrets (for dev)
   - AWS Secrets Manager (for staging/prod)
   - HashiCorp Vault (for staging/prod)
   - Azure Key Vault (for staging/prod)

3. **Reference secrets** in your deployment:

```yaml
# In futbalio.prod.yaml
databases:
  mysql:
    credentials:
      password: "${MYSQL_PASSWORD}" # Placeholder


# The actual secret is in external secret manager
# Your CI/CD pipeline injects it at deploy time
```

### Git Ignore

The `.gitignore` in this directory is configured to:

- ✅ **Keep** the example templates (`futbalio.*.yaml`)
- ❌ **Ignore** local overrides with real secrets

If you create personal override files (e.g., `my-local.yaml`), they won't be committed.

## Migrating from Legacy Config

If you have existing configuration in `src/config.ts`, you can migrate:

1. Extract settings to YAML files in this directory
2. Remove hardcoded values from `config.ts`
3. Update TypeScript to load from YAML via `loadConfig()`

See the parent [.infra/README.md](../README.md) for details.

## Troubleshooting

### Configuration not loading

Check:

1. File names match pattern: `futbalio.{env}.yaml`
2. YAML syntax is valid: `yq eval config/futbalio.local.yaml`
3. `APP_ENV` environment variable is set correctly

### Values not merging correctly

Remember the merge order:

- Common → Service Common → Environment

Use `yq` to inspect merged output during development.

### Secrets not working

In local/dev, secrets are inline in YAML (less secure but convenient).
In staging/prod, use external secret managers - never inline.

---

For more information, see the [parent .infra README](../README.md).
