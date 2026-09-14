# v0.8.2

This patch hardens credential handling and release installation. Asset URL credentials are redacted from public output, registry credentials are restricted to trusted token-service origins, and the root setup Action verifies release provenance by default. Private registries with a separate token service must explicitly configure trusted origins; see the registry documentation.

The CLI container refreshes OS packages during its build. Continuous dependency and container security scanning has been added. Dependency updates refresh Bun types, the native font-validation fixture, and pinned publishing Actions. Future scheduled updates are consolidated into one cross-ecosystem Dependabot PR while required CI remains enforced.

TypeScript remains at 5.9.3 because version 7 removed compiler APIs used by bunko. The migration is tracked in [#185](https://github.com/sakajunquality/bunko/issues/185). Supported Bun versions and runtime/rebase compatibility boundaries are unchanged.

The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0; use `version: v0.8.2` to select this release. See the [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.8.2.md).
