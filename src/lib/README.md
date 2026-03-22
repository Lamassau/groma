# Infrastructure Library

A comprehensive, reusable infrastructure-as-code library for Kubernetes deployments using CDK8s. This library provides type-safe, composable constructs for building full-stack applications.

## 🏗️ Organization

```
lib/
├── core/           # Core types and interfaces
├── config/         # Configuration utilities
├── constructs/     # Reusable CDK8s constructs
├── charts/         # Pre-built chart patterns
├── utils/          # Common utilities
└── k8s.ts          # Generated Kubernetes API objects
```

## 🚀 Quick Start

### 1. Basic Usage

```typescript
import {
  loadDevEnvConfig,
  buildFullStackConfig,
  ModernFullStackChart,
} from "./lib";

// Load configuration from devenv.yaml
const devEnvConfig = loadDevEnvConfig();

// Build full-stack configuration
const config = buildFullStackConfig(devEnvConfig, "futbalio", {
  enableMongoDB: true,
  enableRedis: true,
});

// Create and deploy chart
new ModernFullStackChart(app, "app", { config });
```

### 2. Using Individual Constructs

```typescript
import { MySQLDatabase, ApiService, AppConfigMap } from "./lib/constructs";

// Create a config map
const config = new AppConfigMap(scope, "config", {
  namespace: "futbalio",
  name: "futbalio-config",
  data: { NODE_ENV: "development" },
});

// Create a database
const db = new MySQLDatabase(scope, "mysql", {
  namespace: "futbalio",
  appName: "futbalio",
  config: {
    /* database config */
  },
});

// Create an API service
const api = new ApiService(scope, "api", {
  namespace: "futbalio",
  appName: "futbalio",
  config: {
    /* service config */
  },
  env: db.getConnectionEnv(),
  envFrom: [config.envFromRef()],
});
```

## 📦 Core Modules

### Core Types (`core/`)

Base interfaces and types used throughout the infrastructure:

- `Environment`: Environment types (local, dev, staging, prod)
- `FullStackConfig`: Complete full-stack application configuration
- `DatabaseConfig`: Generic database configuration
- `ServiceConfig`: Application service configuration
- `CacheConfig`: Cache system configuration

### Configuration (`config/`)

Configuration loading and transformation utilities:

- `loadDevEnvConfig()`: Load devenv.yaml configuration
- `buildFullStackConfig()`: Transform devenv config to standardized format
- `generatePassword()`: Environment-specific password generation

### Constructs (`constructs/`)

Reusable CDK8s constructs for common infrastructure components:

#### Configuration Management

- `AppConfigMap`: Standardized ConfigMap with environment injection
- `AppSecret`: Standardized Secret with secure references

#### Databases

- `MySQLDatabase`: MySQL with persistent storage and health checks
- `MongoDatabase`: MongoDB with persistent storage and health checks

#### Cache Systems

- `RedisCache`: Redis with optional persistence
- `ValkeyCache`: Valkey (Redis-compatible) cache

#### Application Services

- `ApplicationService`: Generic containerized service
- `ApiService`: API service with health checks and scaling
- `WebService`: Frontend service with ingress support

#### Development Tools

- `DatabaseAdmin`: Database management UI (WhoDB)
- `DevTool`: Generic development tool construct

### Charts (`charts/`)

Pre-built chart patterns for complete application stacks:

- `ModernFullStackChart`: Complete full-stack deployment
- `TraefikChart`: Traefik ingress controller
- `MetalLBConfigChart`: MetalLB load balancer configuration

## 🔧 Configuration

### DevEnv Configuration

The library reads from `devenv.yaml` to automatically configure:

- Container registry settings
- Domain names and networking
- Build configurations
- Platform-specific settings

### Environment-Specific Behavior

The library automatically adapts based on environment:

**Development (`dev`)**:

- Single replica services
- Development tools enabled
- Smaller storage allocations
- Debug-friendly settings

**Production (`prod`)**:

- Multi-replica services for HA
- Development tools disabled
- Larger storage allocations
- Production-optimized settings

## 🛡️ Best Practices

### Reusability

- All constructs are designed to be application-agnostic
- Use `appName` parameter for resource naming and labeling
- Leverage `labels` prop for custom labeling strategies

### Security

- Secrets are handled separately from configuration
- Passwords are environment-specific
- Production deployments disable development tools

### Scalability

- Resource limits are environment-aware
- Databases use persistent volumes
- Services include readiness/liveness probes

### Maintainability

- Clean separation of concerns between modules
- Comprehensive TypeScript interfaces
- Self-documenting configuration objects

## 🆕 Migration from Legacy

The library maintains backward compatibility while encouraging migration to the new system:

```typescript
// Legacy (deprecated)
import { devConfig, prodConfig } from "./config";

// Modern (recommended)
import { buildFullStackConfig, ModernFullStackChart } from "./lib";
```

## 🤝 Contributing

When adding new constructs or features:

1. Follow the existing patterns and interfaces
2. Add comprehensive TypeScript documentation
3. Include health checks and resource limits
4. Update the appropriate index.ts files
5. Test with multiple environments

## 📚 Examples

See the `charts/modern-full-stack.ts` for a complete example of how all constructs work together to create a production-ready full-stack application deployment.
