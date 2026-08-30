# Migration from the original .infra layout

Existing users can continue importing FullStackChart and constructs from src/lib (or the compiled package exports). Existing `pnpm synth:local`, `synth:dev`, etc. still use src/main.ts, the legacy Futbalio wrapper and .devenv layout. This avoids silently changing existing deployments.

For new projects prefer the generic CLI: `groma init`, explicit schemaVersion, and project-local groma.yaml. There is no automatic conversion of bespoke TypeScript charts; migrate a copy, synthesize both outputs and review differences before deployment. The generic CLI is not feature-equivalent to the legacy full-stack chart.

Behavior corrections in the legacy API:

- Infrastructure booleans and numeric .env values are parsed into real types. App environment values remain strings. Invalid typed values now fail.
- Disabled/unselected databases no longer require credentials or storage values.
- `IMAGE_TAG` overrides the legacy `local` tag.
- `ingress.enabled: false` emits no API/web ingress routes.
- Standard Ingress is the default. Set `ingress.mode: traefik` (or `INGRESS__MODE=traefik`) for Traefik CRDs instead. Both are no longer emitted at once. Review existing live routes and explicitly remove obsolete resources after migration; kubectl apply does not prune them.
- External-secret mode without a named store throws instead of falling back to an inline Secret. Legacy database constructs still use their own credential Secrets; do not assume app-level external-secret mode covers them.
- Diff scripts treat kubectl's differences exit code as expected, but preserve synthesis and real diff failures.

The generic renderer supports API-only, web-only and worker-only applications with no required databases. It uses pre-existing secret references and explicit volumes. Legacy backup, HPA, PDB, quota and network-policy constructs remain available through the library; the new generic renderer does not automatically invoke them.
