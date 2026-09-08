# Disposable application validation fixture

Run from the repository root with `bun run build && bun run test:application-validation`. The runner creates the generated asset context and disposable PostgreSQL service automatically. This independently authored fixture contains no private workload configuration or service credentials. See [the validation guide](../../docs/APPLICATION_VALIDATION.md) for scope and cleanup.
