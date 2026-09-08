# v0.1.0-alpha.2

This alpha candidate adds local development interoperability, clearer supply-chain metadata and more control over build inputs and caches.

- Exclude optional context files with `.bunkoignore`; reuse application output using conservative target inputs and an actual bundle-input backstop. Inspect plain/JSON stage progress.
- Resolve manifests into local Docker or kind images, and apply to the matching kind context. Select prepared dependencies per workspace target with validated platform, lock and target bindings.
- Read bounded zstd base layers and configure host-specific private CA/client certificates. Generated layers remain gzip.
- Export verified SPDX/provenance payloads from OCI layouts or registries. Include recognized license declarations and Bun runtime identity; link a platform-bound external base SPDX document.
- Record actual builder and Bun executable fingerprints. Optionally verify prepared dependency signatures before import. Enable the explicit CI profile to require reproducibility, metadata and signing.
- Read multiple trusted Registry caches while writing to one destination, or disable Registry cache writes. Persist accepted remote hits locally after build checks.
- Report managed local cache usage and preview age/byte-budget retention. Delete only with `--execute`, retaining shared blobs and leaving unknown/unreferenced files untouched.
- Replace internal development phase names with feature-based documentation, commands and test names.

## Migration and limits

The cache packing version changes. Older caches are treated as misses. Builder fingerprints and host compressor versions participate in image identity, so source and bundled CLI installations can produce different image digests despite sharing a version string. Hold the same builder/toolchain/base inputs constant for reproducibility comparisons. Metadata flags alone do not change runnable image identity.

YAML scalar references must contain an exact valid `bunko://` URI. A `|` block retaining its trailing newline fails with `Invalid bunko reference`; `|-` can contain a valid reference. Leading `./` workspace patterns are normalized. Runtime scripts, macros and source symlinks remain unsupported by ordinary builds; prepared dependency artifacts handle externally generated files.

Caches and their writers must be trusted. Digest verification does not prove that a cache producer used the claimed inputs, and producer-key policy does not authenticate application caches. Metadata is opt-in and self-reported. External base SPDX linkage does not establish independent OS scanning, publisher trust or a SLSA assurance level.

The JavaScript distribution contains `bunko.js`, `SHA256SUMS`, `LICENSE` (MIT) and `THIRD_PARTY_NOTICES.md`. It requires Bun >=1.3.11 <1.4; CI covers Bun 1.3.11/1.3.12 on Linux/macOS. Target images support Linux amd64/arm64. The CLI bundle requires no external npm runtime dependencies; YAML and TypeScript notices are included.

GHCR and Artifact Registry have dedicated private live evidence. Docker Hub account publication and private ECR remain unverified. See [compatibility](COMPATIBILITY.md), [metadata](METADATA.md), [cache retention](CACHE_RETENTION.md), and [comparison](COMPARISON.md) for exact scope. Release preparation does not change repository visibility or publish to npm.
