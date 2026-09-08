# Feature guide

Bunko builds Linux OCI images directly from Bun applications. It runs Bun dependency preparation and bundling on the host, then composes image layers and publishes or exports them. It does not require a Docker daemon for a Registry build; Docker and kind are optional local runtime integrations.

| Area | Guide |
| --- | --- |
| Supported hosts, Bun versions and target platforms | [Compatibility](COMPATIBILITY.md) |
| Build inputs, configuration and reproducibility | [Specification](SPEC.md) |
| Context exclusions, caching, progress and measured costs | [Performance](PERFORMANCE.md), [Build comparison](BUILD_COMPARISON.md) |
| Workspaces and dependency closures | [Specification](SPEC.md#8-workspaces-and-multiple-targets) |
| Local Docker/kind manifests and prepared dependencies | [Local development](LOCAL_DEVELOPMENT.md) |
| Registry authentication, private CA and mTLS | [Registries](REGISTRIES.md) |
| SPDX, provenance, signing and producer policy | [Metadata](METADATA.md), [Supply chain](SUPPLY_CHAIN.md) |
| Cache read sources, usage and retention | [Cache retention](CACHE_RETENTION.md) |
| Apply, prepared artifacts and layout publication | [Operations](OPERATIONS.md) |
| Distribution and setup Action | [Releasing](RELEASING.md) |
| Scope compared with ko and BuildKit | [Comparison](COMPARISON.md) |

The [release notes](RELEASE_NOTES.md) describe the rc.1 release candidate. Validation reports identify their tested revisions, fixture scope and environments; a historical passing result is not a claim that every provider or workload is supported.
