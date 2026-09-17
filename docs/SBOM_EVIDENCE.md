# Build evidence for SBOM consumers

Bunko can describe how it assembled an application, complementing an image scanner. It should preserve observations and their limits before adding vulnerability conclusions. This document separates the implemented evidence contract from proposed follow-ups.

## Available now

```sh
bunko build . --push=false --oci-layout ./image --sbom --sbom-evidence
bunko metadata layout:./image --metadata-dir ./metadata
```

`--sbom-evidence` requires SBOM generation (`--sbom`, or the CI supply-chain policy). It deliberately opts into disclosing lockfile package names, including development dependencies and other members of a shared workspace lock. Default `--sbom` retains its existing inventory and disclosure scope. No registry URLs, workspace paths, credentials, source paths or build parameter values are copied into evidence.

With evidence enabled, each included package also has standard SPDX `sourceInfo` describing observed states and expected source-archive integrity. This is readable without decoding a document annotation; scanner support for displaying or interpreting this field varies. It does not add archive hashes as installed-file checksums. Rebase regenerates these fields from validated evidence.

Each platform SPDX 2.3 document has one standard `OTHER` annotation whose comment begins `bunko:build-evidence:v1 ` followed by canonical JSON. Consumers that do not understand the annotation still receive the existing package inventory. Declared-only packages are not added to SPDX `packages` or linked with `CONTAINS`; ordinary scanners must not interpret the declaration list as installed software.

The annotation contains:

- `schemaVersion: 1` and `scope: "application-inventory"`.
- `lockDigest`, when available: SHA256 of Bunko's canonical parsed lock object, not the raw lockfile bytes. This is the same digest recorded as `urn:bunko:lock` in build provenance.
- `packages`, sorted by name and version. Each record has `name`, `version`, `states` and `lockChecksums`.

| State | Observation | What it does not prove |
| --- | --- | --- |
| `bundled` | The existing bundle-input inventory identified this package. | All or any particular functions survived tree-shaking. |
| `runtime` | The packaged runtime dependency inventory identified this package. | Execution, vulnerability reachability, or unmodified registry bytes. |
| `declared-only` | A registry package occurs in the validated lock, but not either collected application inventory. | Absence from the entire image, assets, a base layer, dynamically loaded code, or an opaque executable. |

A package may have both `bundled` and `runtime` states. `declared-only` is exclusive. This is a set of observations, not an exclusive three-way classification of all image contents. Workspace entries without registry archive integrity are not invented as registry packages. Missing locks and empty checksum lists mean no lock evidence is available.

`lockChecksums` contains algorithm/hex pairs decoded from SHA256, SHA384 or SHA512 lock integrity. Matching uses package name and version; all distinct matching archive digests are retained rather than choosing one for aliases or multiple resolutions. These are expected **source archive** checksums, not independently measured package/file checksums. Bun caches, patches, lifecycle scripts, pruning and bundling can change the installed or emitted bytes. The evidence therefore does not write these values into SPDX package checksums or modify npm purls. No tarball is fetched or file tree rehashed to create this evidence.

Evidence is limited to 2 MiB per platform. Above the limit, deterministic degradation first omits all declared-only entries, then lock checksums, then (only if necessary) the remaining package evidence. The ordinary SPDX package inventory is never removed by this evidence budget. Degraded annotations use `bunko:build-evidence:v2 `, `schemaVersion: 2`, and an `omitted` object with counts for `declaredOnlyPackages`, `lockChecksums`, and `includedPackages`. Missing detail is unknown, never evidence of absence. Consumers of v1 must explicitly support v2 before interpreting degraded evidence. Malformed lock integrity still fails explicitly. It is rebuilt from the current validated plan and current or cached inventories. It does not change runnable image layers, manifest identity or cache keys. Rebase with `--sbom` validates and preserves existing application evidence, replaces the document subject, and does not invent evidence for older SBOMs or rescan application code. Unknown evidence versions, inconsistent package membership and duplicate evidence annotations fail. Rebase does not accept `--sbom-evidence` to collect new evidence.

This annotation is a Bunko extension inside valid SPDX, not a standard vulnerability or provenance verdict. `metadata` exports it unchanged after ordinary artifact digest/subject checks. A verified image or document signature and a trusted builder are separate trust requirements.

## Findings behind the design

### Build input is not final-output proof

`bundle-worker.ts` already emits a metafile; `toolchain.ts` already derives a package inventory from its inputs. Bun documents input/output and per-output contribution data in its [metafile API](https://bun.com/reference/bun/BuildOutput/metafile). These are different observations. Before exporting file evidence, test contribution accounting across supported Bun versions, splitting, minification, assets, source maps, conditional exports and compile mode. A source file's SHA256 proves the bytes read, not that all those bytes or a vulnerable function occur in the output.

SPDX `filesAnalyzed` describes file analysis; setting it to true also creates package verification-code obligations. It is not an inclusion-confidence flag. Keep it false until the corresponding file model and verification code are correctly implemented. [SPDX package information](https://spdx.github.io/spdx-spec/v2.3/package-information/), [file information](https://spdx.github.io/spdx-spec/v2.3/file-information/).

### Absence needs a coverage boundary

OpenVEX statements identify a vulnerability and product as well as a status. `component_not_present` and `vulnerable_code_not_present` are assessments, not interchangeable labels for an absent input record. A database is not necessary inside Bunko, but an advisory identity, a reliable mapping to affected components/code, complete coverage of relevant locations, and assessment provenance are necessary before generating `not_affected`. No VEX is generated by this change. [OpenVEX specification](https://github.com/openvex/spec/blob/main/OPENVEX-SPEC.md).

### Builder evidence complements existing tools

BuildKit can already include build contexts and intermediate stages in scanner-generated SBOMs. The useful distinction is precise Bun assembly evidence, not a claim that no other builder sees build-time inputs. Preserve explicit boundaries between observed inputs, final filesystem contents and execution. [Docker SBOM attestations](https://docs.docker.com/build/metadata/attestations/sbom/).

CycloneDX supports component evidence, including occurrences and identity evidence. A location must say whether it refers to an input or a final artifact. A schema version alone will not make consumers understand Bun-specific semantics. Keep a format-independent evidence model, then verify exporters with real consumer versions. [CycloneDX evidence guide](https://cyclonedx.org/guides/sbom/evidence).

## Proposed implementation sequence

Row 1 describes shipped functionality. Rows 2 onward are follow-up plans, not supported CLI flags or shipped capabilities.

| Order | Work | Acceptance gate |
| --- | --- | --- |
| 1 | Implemented package states and source-archive integrity evidence. | Deterministic documents, opt-in declaration disclosure, no false `CONTAINS`, cached/uncached parity and rebase preservation. |
| 2 | File-level input hashes, per-output contributions and closure dependency reasons. | Relative paths, bounded hashing, package-instance identity, cold/warm cache equality, compile/source/multiple-entrypoint coverage, accurate distinction between input and output locations. |
| 3 | CycloneDX exporter and advisory-driven VEX assessment workflow. | Schema validation and tested import by selected Dependency-Track, Trivy and Grype versions. Default to unknown/under-investigation when evidence is incomplete. No automatic vulnerability suppression from lock-only observations. |
| 4 | Bun release component manifests. | Data tied to exact verified release/revision, platform, build recipe and distribution artifact; reproducible extraction with source/license references and completeness status. Unknown custom runtimes remain unknown. |
| 5 | Optional base package-database inventory. | Explicit contract amendment; bounded parsers and merged-filesystem tests for dpkg status/status.d and APK installed databases, including whiteouts, duplicates, malformed records and distro identity. |
| 6 | Consumer discovery and multi-platform aggregation. | Test native referrers, existing fallback, any compatibility tags and in-toto/DSSE separately. Link exact platform document digests without flattening conflicting versions or treating an index document as the SPDX inventory of one filesystem. |
| 7 | Diff and policy, then registry-wide search. | Compare explicit image subjects and coverage; offline policy fixtures; authenticated, paginated, bounded discovery across explicit repositories. Report inaccessible and unindexed images instead of claiming a complete search. |

### File, closure and native evidence

Extend package identity beyond name/version before attaching instance-specific file lists: the same version can occur in different locations with different patches. Collect SHA256 at the point frozen input bytes are read, with bounded concurrency. Record output contributions only where the toolchain actually reports them. Do not turn `hasFiles` into a claim that source paths exist in the image. Closure edges should retain their reason (declared, optional, observed or workspace) and use the exact packaged instance. Account for these fields in cache validation/versioning and rebase sanitization before shipping them.

ELF `DT_NEEDED` and base capability lookup are useful compatibility evidence. A library filename is not automatically an identified SPDX package, and a present file is not proof of loader resolution, symbol versions or ABI compatibility. Record `present`, `missing` and `unknown` separately, including lookup scope and platform. Foreign addon omissions are build decisions, not package-wide absence proofs. Keep compatibility evidence distinct from software ownership relationships until the supplying component can be identified.

### Bun's statically linked components

A revision-indexed component manifest could expose dependencies scanners miss, but a source checkout's dependency declarations are only a candidate list. They do not alone prove which components, patches or features were linked into a particular shipped binary. Generate data from the exact release's build sources and attestations, verify names/versions/licenses, and identify the parent binary digest. Treat default-base runtime identity, verified injected runtime identity and verified compiled runtime identity separately. Do not label BoringSSL, JavaScriptCore or another component as present merely because it appears in a generic Bun dependency list. Avoid promising complete vulnerability coverage or exclusive capabilities without evidence.

### Base inventory contract

Reading package-manager databases is still a form of OS inventory collection. The existing [retained contract](RECHECK.md) remains unchanged by this PR. A future opt-in parser should clearly revise that contract rather than rename scanning. `base-inspect.ts` traverses layers for filesystem semantics; this does not make retaining every file body free. Reuse selected, bounded database reads, respect whiteouts and symlinks, and record package-manager/distro/architecture identity. Distroless fragments and APK database records need independent fixtures. Imported base SBOMs must remain available for images without usable databases. Missing databases mean unknown coverage, not an empty OS.

### Consumption and operation

Select supported consumer versions before committing to CycloneDX 1.6 or a newer schema. Test the exact stored envelope as well as the payload: raw SPDX referrers, in-toto statements, DSSE envelopes and legacy cosign tags have different discovery paths. Existing `metadata --metadata-dir` already provides local export; a proposed direct build output directory must justify its separate lifecycle. Coordinate any mutable compatibility tag writes and retain subject digest verification.

For `sbom diff`, preserve architecture and package instance identity. Rebase preserves application layers, but runtime identity, base document coverage and metadata can also change; an OS-only diff is not an unconditional guarantee. Registry search needs explicit repository enumeration because registries do not provide a universal wildcard search API. Start with a user-provided image/repository set and bounded local indexing.

Policies should initially consume local evidence and explicit files. License denial must define how `NOASSERTION` behaves. Package denial must distinguish observed runtime/bundle inputs from declarations. Undeclared imports already have build/closure validation paths; avoid a competing implementation. Advisory input must be size-bounded, offline and versioned; never execute advisory-provided URLs or infer a clean bill of health from absent findings. Define/rebase/runtime parameters belong in appropriately redacted provenance rather than duplicating secret-bearing values in SBOMs.


## Dependency relationship limitation

The SBOM currently relates the image to included application/runtime packages and explicitly linked base inventories. It does **not** emit npm package-to-package `DEPENDS_ON` edges or closure explanation paths. Lock declarations are not treated as proof of runtime dependency relationships. Package evidence, standard `sourceInfo`, and document annotations do not provide a resolved dependency graph, file-level occurrence proof, VEX, or automatic scanner suppression.
