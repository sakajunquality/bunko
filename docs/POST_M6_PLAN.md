# Post-M6 comparison and proposed roadmap

Research date: 2026-09-08 JST. Bunko baseline: merged main `ea9d0c0414284416355501a448ac536c9832a36b`. GitHub's latest stable releases at inspection were [ko v0.19.1](https://github.com/ko-build/ko/releases/tag/v0.19.1) and [BuildKit v0.33.0](https://github.com/moby/buildkit/releases/tag/v0.33.0). The ko release-tag cache documentation and resolver source, and BuildKit's release-tag README, were checked alongside official documentation. Web documentation can move independently of release tags.

This is a source/documentation comparison and proposed plan, not a new runtime conformance or performance result. No implementation described as proposed below has shipped. Both repositories remain private; M3–M6 and the first ko gap increment are merged. See [KO_GAPS.md](KO_GAPS.md) for the original comparison and [LIVE_REGISTRY_VALIDATION.md](LIVE_REGISTRY_VALIDATION.md) for actual registry evidence.

## Additional ko differences

| Capability | Current Bunko evidence | Recommendation |
| --- | --- | --- |
| Resolve directly into a local Docker environment | ko documents `resolve --local`; `resolveDocuments()` currently rejects local, kind, layout, tarball, and dry-run modes | Add a local development workflow, including explicit kind loading and rendered references suitable for the selected runtime. This was missing from the earlier parity table. |
| Dependency-sensitive iterative builds | ko reuses Go's compiler cache and optionally KOCACHE; Bunko's application key uses the complete snapshot, host, base, and dependency inputs | Improve target input tracking. Do not claim that Bun has a Go-equivalent incremental compiler cache. |
| Default SBOM and standalone export | ko defaults to SPDX and supports `--sbom-dir`; Bunko generates optional npm inventory artifacts and exports them inside layouts | Add explicit metadata extraction first; consider a documented CI profile enabling required metadata before changing CLI defaults. |
| TLS option semantics | ko describes `--insecure-registry` as skipping TLS verification; Bunko uses a repeated host permission for plain HTTP | Document the incompatibility clearly. Prefer registry-scoped CA and client certificate support over adopting a blanket TLS bypass. |
| Static assets and debugging | Bunko includes bunkodata but rejects source symlinks; it has sourcemaps but no inspector workflow | Keep containment rules. Add a Bun debugging recipe if requested; do not expose an inspector by default. |
| Platform/configuration breadth | Bunko supports two Linux architectures and constrained package/workspace configuration | Keep explicit supported platforms. Go import-path naming, Delve, and Go build flags remain language-specific differences. |

Sources: [ko resolve](https://ko.build/reference/ko_resolve/), [build cache](https://ko.build/features/build-cache/), [build options](https://ko.build/reference/ko_build/), [SBOMs](https://ko.build/features/sboms/), [static assets](https://ko.build/features/static-assets/). ko's CLI selector help lists fewer operators than its release-tag implementation: the implementation delegates to Kubernetes label parsing. Bunko's set operators should not be advertised as a unique advantage on the basis of that help text.

## BuildKit differences that matter to Bunko

BuildKit is a general build execution backend with a dependency graph, workers, and frontend integrations. Bunko directly installs/bundles with Bun and composes OCI images. Matching every BuildKit capability would change the product's scope.

| Area | Confirmed Bunko gap or boundary | Proposed treatment |
| --- | --- | --- |
| Input selection | `files.ts` has fixed exclusions; there is no user ignore file. The workspace snapshot and application key include unrelated files. Installed JS/TS still receives a cold parser scan. | Add explicit context exclusions and then dependency-aware target keys, with conservative fallback. Measure both snapshot and parser cost. |
| Scheduling | `--jobs` bounds target preparation; platforms inside a target and subsequent publication are largely sequential. It is not a build graph scheduler. | Share identical preparation work and add separate bounded install/build/transfer budgets only where benchmarks justify them. |
| Base updates | The base digest participates in dependency/application keys. There is no guarded rebase operation. | Investigate reusing base-independent outputs after defining Bun/libc/native compatibility gates. A digest change alone must not imply ABI compatibility. |
| Compression | `source.ts` accepts raw/gzip base layers and rejects zstd; generated layers use gzip. BuildKit supports additional compression formats. | Prioritize reading/verifying zstd bases before optional zstd output. Treat eStargz lazy-pull optimization as a separate runtime-dependent project. |
| Native/generated dependencies | Bunko disables install scripts; `pack-deps` packages an already prepared standalone tree. No automated BuildKit producer exists. Imported artifacts cannot currently be used by resolve or workspace projection. | Ship a pinned BuildKit recipe producing target-platform dependencies, then extend per-target artifact mapping. Keep arbitrary execution outside the core builder. |
| Isolation and secrets | Bunko uses explicit child environments and rejects executable build features, but its Bun subprocesses run on the host. Existing npm authentication is not a general secret/SSH mount API. | State the boundary accurately. Use BuildKit's execution and secret mounts for preparation that needs them; do not describe environment sanitization as an OS sandbox. |
| Cache distribution | Bunko has local/custom-registry caches, one configured cache repository, and explicit pruning. These are not BuildKit cache records. | Add separate read sources/write destination if CI needs it; then usage reporting and size-based local retention. Defer native gha/S3/Azure backends and BuildKit cache-format ingestion. |
| Supply-chain coverage | `attest.ts` lists bundled/runtime npm package names and versions; licenses are NOASSERTION. It does not inventory the base OS, and compile mode does not separately inventory the embedded Bun runtime. | Add runtime identity, available package metadata, explicit base-SBOM linkage or a scanner adapter, and tool interoperability tests. Preserve unknown/partial coverage labels. |
| Provenance and trust | Bunko emits a minimal self-reported SLSA v1 predicate. It does not establish a SLSA assurance level or automatically enforce signatures on imported dependency artifacts. | Identify the actual builder revision/artifact, record safe normalized input identities, and add explicit producer verification policy. Never serialize secrets or imply stronger assurance from schema alone. |
| Registry configuration | The public RegistryOptions surface has no host-specific CA/client certificate/mirror configuration. Runtime trust behavior is not a documented, tested replacement. | Test private CA and mTLS paths, add explicit configuration, and separately evaluate mirrors. Retain cross-origin credential isolation. |
| Progress and diagnostics | Bunko provides text logs and completion/partial-failure reports, but no stable per-stage event stream, build history service, or OTel integration. | Start with JSON progress events and stage timings/cache-miss reasons. Keep timing outside image identity. |
| General build features | No Dockerfile/LLB frontend, remote worker service, arbitrary RUN, multi-stage OS package installation, or generic remote contexts | Defer these to BuildKit. An optional adapter is more appropriate than duplicating its execution engine. |

Sources: [BuildKit architecture and input/graph behavior](https://docs.docker.com/build/buildkit/), [v0.33.0 features/export/cache options](https://github.com/moby/buildkit/blob/v0.33.0/README.md), [context exclusions](https://docs.docker.com/build/concepts/context/#dockerignore-files), [COPY --link and conditional rebase](https://docs.docker.com/reference/dockerfile/#copy---link), [secret mounts](https://docs.docker.com/build/building/secrets/), [cache backends and multiple imports](https://docs.docker.com/build/cache/backends/), [SBOM scan scope](https://docs.docker.com/build/metadata/attestations/sbom/), [provenance modes](https://docs.docker.com/build/metadata/attestations/slsa-provenance/), [registry TLS/GC/worker configuration](https://docs.docker.com/build/buildkit/toml-configuration/).

BuildKit capabilities depend on frontend, exporter, worker, and configuration. SBOM generation is opt-in and its default scan scope is the final stage, not every build dependency. Buildx defaults must not be presented as unconditional standalone BuildKit defaults. BuildKit OCI metadata and Bunko subject artifacts should be tested with actual consumers; a shared SPDX label does not establish discovery or verification compatibility.

## Proposed implementation order

### M7: trustworthy baseline and measurable performance

1. Reconcile SPEC sections 6–7 and historical DESIGN statements with M5/M6. SPEC still says application caching, locks, prune and jobs are unimplemented and describes lazy cache verification; the later M5 section supersedes these statements. Update the merged-PR status and cross-links.
2. Add stable phase timings and an experiment harness comparing Bunko with a well-tuned Bun multi-stage BuildKit Dockerfile. ko is a workflow reference, not a same-language throughput baseline.
3. Run repeated cold, unchanged warm, fresh-runner/remote-warm, app edit, unrelated workspace edit, assets edit, dependency edit and base update scenarios. Match Bun revision, base digest, architecture, output mode, compression and metadata settings; separate payload/metadata/wire traffic. Record median/range, CPU/RSS and environment.
4. Implement explicit context exclusions and target input identity. Acceptance: excluded changes do not alter the effective snapshot; actual imports, tsconfig changes, package resolution changes, patches and relevant assets invalidate the right outputs. Missing/excluded required inputs fail. Retain conservative full-snapshot fallback for uncertain resolution.
5. Optimize parser validation and repeated preparation without moving macro rejection after executable bundling. Acceptance: dangerous syntax remains rejected before execution, repeated-input work decreases, and bounded file/memory behavior is demonstrated on large fixtures.

Image identity needs an explicit decision: even if a target's layer is unchanged, whole-repository Git labels or audit metadata can change its config/root digest. Keep build-input identity distinct from audit identity and do not promise stable image digests while retaining changing labels.

### M8: local development and BuildKit interoperability

1. Add resolve/local-kind output modes. Define reference naming, imagePullPolicy guidance, all-node load verification and partial-failure reporting before implementation. Acceptance: a disposable kind deployment works without registry access, including selected manifests and duplicate references.
2. Add the BuildKit prepared-dependencies example with pinned producer inputs and secret mounts where required. Validate amd64/arm64 generated/native fixtures. Extend artifact selection to resolve/workspaces as a separate PR with topology and lock checks.
3. Add zstd base consumption with streaming bounds, compressed-digest/DiffID checks and corrupt/truncated fixtures; confirm resulting layouts/published images load and run. New compression output comes later.
4. Add private-CA/mTLS conformance. Finish Docker Hub/ECR account-specific checks when dedicated destinations/credentials are available; protocol tests alone remain insufficient.

### M9: useful and verifiable supply-chain metadata

1. Improve SPDX runtime/package details and add metadata export/download for normal external tooling.
2. Link verified base inventories or integrate a scanner with explicit scope. Test images containing both bundled dependencies and native externals; avoid confusing bundled package inventory with filesystem-only scanning.
3. Record actual builder identity and safe input fingerprints in provenance; enforce optional trusted-producer policy before dependency artifact use. Private key/KMS signing remains supported without public transparency-log submission.
4. Define an opt-in CI policy requiring metadata and verification, then consider default changes with a migration plan. Acceptance includes real registry discovery, external consumer parsing, signature rejection and secret-leak checks.

### M10: optimize from evidence

Consider multi-source caches, quota-based local GC, finer scheduling, guarded rebase and richer tracing in that order only when M7 data or user workflows justify them. Native dependencies must retain base compatibility constraints. Generic workers, arbitrary Dockerfile builds, broad architecture support and public releases are outside this proposed increment.

Each implementation PR should include targeted regressions and relevant runtime/protocol evidence, followed by the existing CI matrix and Claude read-only review when available. This research-only change does not rerun the already-green runtime suite or claim new performance measurements.
