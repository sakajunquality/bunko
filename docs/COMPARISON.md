# Comparison with ko and BuildKit

Research reference date: 2026-09-08 JST. Sources were checked against [ko v0.19.1](https://github.com/ko-build/ko/releases/tag/v0.19.1) and [BuildKit v0.33.0](https://github.com/moby/buildkit/releases/tag/v0.33.0), plus official documentation. Bunko behavior below describes the current main branch; immutable release-specific evidence is in the [release notes](RELEASE_NOTES.md). This is a scope comparison, not a claim of complete compatibility or a throughput ranking.

ko is the workflow reference for building images directly from language source and resolving deployment manifests. BuildKit is a general build execution backend with workers and frontends. Bunko directly uses Bun and composes OCI images; duplicating BuildKit's execution engine would change that scope.

| Area | Bunko behavior | Remaining difference or boundary |
| --- | --- | --- |
| Source-to-image workflow | Build, resolve, local Docker/kind output, explicit apply | Bun package/workspace paths replace Go import paths; this is not CLI compatibility |
| Input selection | `.bunkoignore`, source-mode `.gitignore`, conservative per-target reuse, actual bundle-input backstop | No Go-equivalent incremental compiler cache or arbitrary Docker context frontend |
| Work sharing | Bounded target jobs, syntax memoization, reuse of identical per-target bundles across platforms | No general dependency-graph scheduler or remote worker service |
| Assets and configuration | Explicit assets/bunkodata, contained sources, constrained package configuration | Source symlinks and executable application build features remain rejected |
| Prepared dependencies | Platform/lock/target-bound artifacts, optional producer-key verification, BuildKit preparation recipe | Arbitrary RUN and native generation happen outside Bunko; producer must construct a self-contained tree |
| Compression | Raw, gzip and bounded zstd base reading; generated layers use gzip | No eStargz lazy pull or selectable zstd output |
| Registry trust | Docker credentials, host-scoped private CA/client certificates, prefixed pull mirrors | `--insecure-registry HOST` permits HTTP; it does not mean ko's TLS-verification bypass |
| Registry caches | Multiple read sources, one write destination, read-only mode | Custom OCI records, not BuildKit cache format, gha/S3/Azure cache backends |
| Local retention | Managed usage, age or byte-budget previews, explicit deletion | Unknown/unreferenced files remain untouched; no total disk quota or automatic GC |
| SPDX | Opt-in package/license/runtime inventory, platform-bound external base document, exact-payload export | ko defaults to SBOM generation; Bunko does not scan the base OS itself |
| Provenance/signing | Self-reported SLSA v1 predicate, builder/Bun digests, private key/KMS signing, CI policy | No claimed SLSA assurance level, public keyless workflow or implicit base-image trust policy |
| Diagnostics | Configuration checks, plain/JSON stage progress, cache reports, partial-failure records and OTLP/HTTP JSON metrics/spans | No build-history service or protobuf exporter |
| Base updates | Explicit base selection, checks and digest validation | No automatic rebase; native ABI constraints stay in cache identity |
| Platforms | Linux amd64 and arm64 targets on documented Bun/host versions | No promise of Go's architecture breadth or every BuildKit platform |
| Isolation | Explicit child environments and containment validation | Host subprocesses are not an OS sandbox; use trusted inputs and isolated runners |

## Evidence

[Build comparison](BUILD_COMPARISON.md) records repeated cold/warm/edit scenarios using a frozen CLI checkpoint. It reports client CPU/RSS and Bunko payload counters with their limitations; it is not a total worker-resource or wire-traffic comparison. [Local interoperability](INTEROPERABILITY_REVIEW.md), [metadata](METADATA_REVIEW.md), [cache distribution](validation/cache-distribution.json), and [live registry validation](LIVE_REGISTRY_VALIDATION.md) provide feature-specific evidence.

GHCR, Artifact Registry and Docker Hub have [published CLI live validation](PUBLISHED_RELEASE_VALIDATION.md). An authenticated GAR upstream base also passed bundle and compile runtime checks. Private ECR remains unverified; implemented protocol authentication does not close that account-specific gap.

## Deferred work

Prioritize additional changes only with workload evidence: finer install/build/transfer concurrency, guarded base-independent reuse, richer tracing, optional scanner adapters, and additional cache backends. Rebase must first define Bun/libc/native compatibility gates. General Dockerfile/LLB frontends, operating-system package installation, remote workers, arbitrary secret/SSH execution and broad platform expansion are outside the current release.

## Sources

- ko: [resolve](https://ko.build/reference/ko_resolve/), [build cache](https://ko.build/features/build-cache/), [build options](https://ko.build/reference/ko_build/), [SBOMs](https://ko.build/features/sboms/), [assets](https://ko.build/features/static-assets/).
- BuildKit: [release-tag feature/cache/export documentation](https://github.com/moby/buildkit/blob/v0.33.0/README.md), [architecture](https://docs.docker.com/build/buildkit/), [contexts](https://docs.docker.com/build/concepts/context/), [cache backends](https://docs.docker.com/build/cache/backends/), [secret mounts](https://docs.docker.com/build/building/secrets/), [SBOM scope](https://docs.docker.com/build/metadata/attestations/sbom/), [provenance](https://docs.docker.com/build/metadata/attestations/slsa-provenance/), [registry TLS and worker configuration](https://docs.docker.com/build/buildkit/toml-configuration/).

BuildKit capabilities depend on frontend, exporter, worker and configuration. Buildx defaults are not unconditional standalone BuildKit defaults. A common SPDX format does not by itself establish common OCI discovery or signature verification behavior.
