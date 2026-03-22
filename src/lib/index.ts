/**
 * Infrastructure Library - Main Index
 *
 * A comprehensive, reusable infrastructure-as-code library for Kubernetes deployments.
 * Provides type-safe, composable constructs for building full-stack applications.
 *
 * ## Modules:
 *
 * - **core**: Core types and interfaces for infrastructure configuration
 * - **config**: Configuration loading and building utilities
 * - **constructs**: Reusable CDK8s constructs for databases, services, etc.
 * - **charts**: Pre-built chart patterns for common application architectures
 * - **utils**: Common utilities for infrastructure management
 *
 * ## Usage:
 *
 * ```typescript
 * import { buildFullStackConfig, ModernFullStackChart } from './lib';
 *
 * const config = buildFullStackConfig(devEnvConfig, 'futbalio');
 * new ModernFullStackChart(app, 'app', { config });
 * ```
 */

// Re-export all modules for convenience
export * from "./charts";
export * from "./config";
export * from "./constructs";
export * from "./core";
// Note: ./k8s is intentionally not re-exported here to avoid name collisions
// with constructs that wrap k8s primitives. Import from "./k8s" directly when needed.
