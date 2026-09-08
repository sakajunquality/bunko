# Architecture

The normative CLI and configuration contract is [SPEC.md](SPEC.md). The [original proposal](archive/SPEC-v0.1.md) is historical; current feature coverage is in [FEATURES.md](FEATURES.md).

## Build pipeline

Bunko discovers a standalone project or matching workspace, validates configuration, and copies a contained source snapshot into temporary storage. Reserved inputs and `.bunkoignore` exclusions are checked before build execution. Required entrypoints, manifests, lockfiles, configuration and selected assets cannot be silently omitted.

Dependency preparation uses the selected Bun executable with a constrained environment, a frozen lock and install scripts disabled. Arbitrary application build scripts and macros are rejected. These checks do not provide an operating-system sandbox: build only trusted inputs on an appropriately isolated host. Packages requiring generated or native build steps can be prepared externally and imported as validated OCI dependency artifacts.

Bundle mode produces JavaScript for Bun. Compile mode uses supported Linux Bun compilation targets. Workspace closure mode projects the actual Linux package instance graph, preserves resolution aliases, and can share a union dependency layer among compatible targets. Closure cache lookup still requires installation and graph verification.

Layers contain dependency files, application assets and application output. Packing normalizes ownership, modes, ordering and timestamps. Content-addressed storage verifies compressed digests; layer validation also verifies the uncompressed DiffID. Parent/child archive collisions and escaping paths or links are rejected before extraction or export.

## Identity and caches

The whole source digest is an audit identity. Conservative per-target input tracking can reuse application output when unrelated workspace members change; uncertain resolution falls back to the whole snapshot. Actual bundle metafile inputs must be covered before an application record is persisted.

Cache keys retain selected toolchain, host compressor, packing format, platform, output configuration and applicable base/dependency identities. Builder source/bundle fingerprints participate in application keys and image labels. Base changes are not assumed to preserve native ABI compatibility.

Cache entries are eagerly materialized and validated before acceptance. Cooperating-process locks serialize local writers and pruning. Readers treat concurrent deletion or corruption as a miss. Unknown files are not deleted as presumed garbage. Registry read sources and the write destination are independent; remote writes follow successful image publication. See [CACHE_RETENTION.md](CACHE_RETENTION.md).

## Preparation and publication

Preparation completes and validates output paths before finishing selected targets. YAML/JSON resolution preserves source formatting and replaces validated scalar references. References containing whitespace, including retained block-scalar newlines, fail before building. `|-` can represent a valid scalar; `|` with a retained trailing newline cannot.

Registry publication orders blobs, manifests, indexes and tags. Interrupted uploads are reconciled against acknowledged offsets or completed blob digests. GHCR and Artifact Registry use monolithic upload paths based on live interoperability evidence. Cross-origin redirects drop credentials and client certificates. Custom TLS trust remains host-scoped and certificate verification stays enabled.

Publication is not transactional across targets, tags or artifacts. Errors can follow successful earlier writes; reports retain those immutable references and pending operations. There is no destructive automatic rollback. Local Docker/kind loading has analogous partial-result reporting.

## Supply-chain metadata

Optional SPDX and provenance artifacts bind to explicit OCI subjects without altering the runnable index. Metadata flags do not change image identity. Builder/toolchain fingerprints, labels and packing versions do affect identity and must be held constant for reproducibility comparisons.

Inventory covers discovered application packages and distinguishes embedded Bun from the expected base runtime. Base OS coverage requires an explicit platform-bound external SPDX document. Digest checks do not establish the truth or publisher trust of that document. Optional prepared-dependency signature verification happens before import, and the opt-in CI profile requires reproducibility, metadata and signing. No SLSA assurance level is implied.

## Scope

Bunko is a Bun-oriented image builder. General Dockerfile execution, operating-system package installation, remote workers, arbitrary secret/SSH mounts, BuildKit cache ingestion, automatic rebasing and broad architecture support belong to separate integrations or future proposals. Current evidence and remaining gaps are recorded in [COMPARISON.md](COMPARISON.md).
