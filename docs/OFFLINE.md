# Prepared bases and offline builds

Source builds after rc.3 support explicit base preparation and bounded offline builds. The immutable rc.3 distribution does not include these commands.

Prepare complete base images while connected:

```sh
bunko prepare-base --base oven/bun:1.3.11-distroless \
  --platform linux/amd64,linux/arm64 --oci-layout prepared/base
```

The command resolves the source root once, verifies every selected platform's manifest, configuration and layer digest/size, and atomically exports a complete OCI layout. Its JSON output records the original source digest and selected image digests. Only selected runnable platforms are exported; unrelated source-index entries are omitted. Existing populated outputs are never overwritten. The selected base-layout directory is excluded from the application source snapshot, including when stored inside the project. Registry authentication, TLS and pull mirrors work as in normal base pulls. `--base-layout` can also prepare a verified subset of an existing layout. This validates OCI content and platform configuration, not execution compatibility; use `check-base --run` separately for runtime checks.

Build with that persistent local base:

```sh
bunko build . --offline --base-layout prepared/base --oci-layout output/image
```

Offline mode disables implicit publication and registry caches. It rejects explicit publication, remote cache inputs, container-engine loading, signing services and telemetry export. Prepared dependency and base-SBOM inputs must use local `layout:` references. No registry credential lookup or runtime download is attempted.

Cold builds without a lockfile can bundle local source immediately. Projects with dependencies require matching application/dependency cache entries from an online build made with the same source, configuration, toolchain and prepared base. An offline cache miss fails before dependency installation; it does not attempt an install using a possibly incomplete npm download cache. Source edits can invalidate that application cache. Closure planning that requires installation also fails offline. Local prepared runtime dependencies alone do not supply the build-time dependency tree.

Compile mode and runtime injection require the signed runtime document and archive already present in the verified runtime cache. Every offline hit is reverified; a missing or corrupt entry fails without fetching a replacement. Warm these inputs with the same online build first. Preserve the explicit `--cache-dir` and `--runtime-cache` directories as applicable, and do not disable local caching when expecting those entries.

Offline mode controls Bunko's managed registry, installer and runtime-download operations. It is not an operating-system network sandbox for caller-provided programs or callbacks. Use a network-disabled container or equivalent isolation when the environment must enforce that broader boundary.

## Validation evidence

A 2026-09-08 probe prepared `oven/bun:1.3.11-distroless` at source index `sha256:6a78966e057efd546873b64d6c173b18a21a10c3da81562863beeaf044c1e2ec` for Linux amd64 and arm64. An online compile warmed the signed runtime cache, then an offline compile with application-cache reuse disabled produced the same image digest on each platform. Both applications executed as UID 65532 with read-only filesystems and networking disabled; their full Bun revision was `af24e281ebacd6ac77c0f14b4206599cf4ae1c9f`. Unit tests also cover cached dependency builds, missing runtime inputs, source-cache misses, corrupt base blobs and explicit remote-operation rejection.
