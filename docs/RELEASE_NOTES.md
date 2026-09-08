# v0.1.0-rc.2

This release candidate makes module-relative file risks visible and adds opt-in signed Bun runtime injection for custom glibc bases.

- Report advisory `BUNKO_MODULE_LOCATION` diagnostics for loaded location-sensitive expressions, including entries and bundled dependencies. Diagnostics use relative paths, are bounded and deduplicated, and replay on application-cache hits. They do not rewrite paths or prove runtime correctness.
- Add `runtime.inject: "release"` / `--runtime-inject release` for explicit glibc bases, bundle mode, Linux amd64/arm64, and official Bun 1.3.11–1.3.13. Verify the official signature and pinned release checksum before extracting a bounded executable. This optional feature requires `gpgv` on the build host.
- Insert a runtime layer with licensing/source notices before dependencies, assets and application output. Cache verified downloads separately, check base destination/loader paths without host extraction, and include release/executable/checksum-document identities in reports, SBOM and provenance.
- Extend `check-base --run` to execute the composed runtime image, including local OCI base input, as nonroot with a read-only filesystem and no network.

## Compatibility and validation

Normal builds still use the existing Bun-containing base contract. Injection does not install libgcc/libstdc++, Node.js, shell tools or application dependencies. A minimal base can run Bun while failing to load a native addon. Source-preserving mode remains unimplemented. See [runtime injection](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.2/docs/RUNTIME_INJECTION.md) and [application compatibility](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.2/docs/APPLICATION_COMPATIBILITY.md).

The generic acceptance fixture covers PostgreSQL migrations/tasks, native hashing, HTTP/static content, exact runtime files and graceful shutdown. Runtime-injection checks cover compatible/static bases, local OCI input, cache reuse and missing native libraries. Exact candidate evidence is recorded with the CLI checksum in the repository's validation documents. These fixtures do not certify React Router, Temporal, Slack or Snowflake application behavior; complete the [remote acceptance checklist](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.2/docs/validation-request.html).

The cache packing format changed with module-location diagnostics, so older application-layer cache records are not reused. No application source or runtime paths are automatically rewritten. Existing `build.define`, explicit runtime environment roots and asset mappings remain available.

Bun >=1.3.11 <1.4 is required for general builds; injection is explicitly limited to 1.3.11, 1.3.12 and 1.3.13. CI covers those versions on Linux/macOS. The distribution contains the standalone JavaScript CLI, SHA256SUMS, MIT license and third-party notices. npm publication is not included.

Registry interoperability evidence in [published release validation](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.2/docs/PUBLISHED_RELEASE_VALIDATION.md) belongs to alpha.2 unless explicitly recorded otherwise. Private ECR remains unverified. Earlier release tags and assets are immutable.
