# Prepared bases and offline builds

rc.4 and later support explicit base preparation and bounded offline builds. The immutable rc.3 distribution does not include these commands.

Prepare complete base images while connected:

```sh
bunko prepare-base --base oven/bun:1.3.11-distroless \
  --platform linux/amd64,linux/arm64 --oci-layout prepared/base
```

The command resolves the source root once, verifies every selected platform's manifest, configuration and layer digest/size, and atomically exports an OCI layout complete for the selected platforms. Its JSON output records the original source digest and selected image digests. The original source image/index bytes are retained, so its digest survives preparation. Only selected runnable graphs are downloaded: an original index can still reference unselected platforms or artifacts whose blobs are absent locally. Requesting an unprepared platform fails offline; bunko does not fetch missing blobs. A layout that contains multiple independent roots has no single original image index, so preparation creates a selected-platform index for it. Existing populated outputs are never overwritten. The selected base-layout directory is excluded from the application source snapshot, including when stored inside the project. Registry authentication, TLS and pull mirrors work as in normal base pulls. `--base-layout` can also prepare a verified subset of an existing layout. This validates OCI content and platform configuration, not execution compatibility; use `check-base --run` separately for runtime checks.

Build with that persistent local base:

```sh
bunko build . --offline --base-layout prepared/base --oci-layout output/image
```

`--offline` is a build-only option; resolve/apply still require their publication or engine-loading workflow. Offline mode disables implicit publication and registry caches. It rejects explicit publication, remote cache inputs, container-engine loading, signing services and telemetry export. Prepared dependency and base-SBOM inputs must use local `layout:` references. No registry credential lookup or runtime download is attempted.

Cold builds without a lockfile can bundle local source immediately. Projects with dependencies require matching application/dependency cache entries from an online build made with the same source, configuration, toolchain and prepared base. An offline cache miss fails before dependency installation; it does not attempt an install using a possibly incomplete npm download cache. Source edits can invalidate that application cache in bundle/compile mode. [Source mode](SOURCE_MODE.md) can package edited source offline when the matching production dependency layer is already cached; it does not need a build-time bundler install. Closure planning that requires installation also fails offline. Local prepared runtime dependencies alone do not supply the build-time dependency tree.

URL asset mappings require the verified file already present in the asset download cache; image asset mappings need a registry and are rejected offline, so stage those files into a directory bound with `--asset-context` instead. Compile mode and runtime injection require the signed runtime document and archive already present in the verified runtime cache. Every offline hit is reverified; a missing or corrupt entry fails without fetching a replacement. Warm these inputs with the same online build first. Preserve the explicit `--cache-dir`, `--runtime-cache` and `--asset-cache` directories as applicable, and do not disable local caching when expecting those entries.

Offline mode controls Bunko's managed registry, installer and runtime-download operations. It is not an operating-system network sandbox for caller-provided programs or callbacks. Use a network-disabled container or equivalent isolation when the environment must enforce that broader boundary.

## Validation evidence

A 2026-09-08 probe prepared `oven/bun:1.3.11-distroless` at source index `sha256:6a78966e057efd546873b64d6c173b18a21a10c3da81562863beeaf044c1e2ec` for Linux amd64 and arm64. An online compile warmed the signed runtime cache, then an offline compile with application-cache reuse disabled produced the same image digest on each platform. This compared online and offline builds using the same prepared layout, not a registry build against a layout build. Both applications executed as UID 65532 with read-only filesystems and networking disabled; their full Bun revision was `af24e281ebacd6ac77c0f14b4206599cf4ae1c9f`. Unit tests also cover cached dependency builds, missing runtime inputs, source-cache misses, corrupt base blobs and explicit remote-operation rejection.

Prepared layouts contain one named source manifest or index (`bunko.local/prepared-base:sha256-…`). Platform aliases are normalized before deduplication, so `linux/arm64,linux/arm64/v8` selects one image. Preparation verifies descriptor digests and sizes for the complete selected graphs; it does not independently decompress every layer to verify its DiffID. The first build against a given base digest decodes its layers and verifies DiffIDs while checking filesystem compatibility, and records the resulting filesystem metadata in the local cache. A later build that replays that record performs no decode, so DiffIDs are verified only where the layer bytes are materialized: a Docker archive export (`--tarball`, `--local`, `--kind`) decodes and verifies every layer, an OCI layout export checks compressed digests and sizes, and a mounted or already-present blob at a registry destination is neither read nor verified locally. `--no-cache` and `--no-local-cache` inspect from the layers on every build. Runtime execution compatibility checks remain separate.

For offline cache misses, retain local caches and use normal cache reads. `--no-local-cache` intentionally bypasses reusable entries and may require unavailable installation. `prepare-base` materializes base inputs; it does not warm application or dependency caches.

## Base identity

The outer layout `index.json` is a transport envelope. For a layout containing one image/index, `org.bunko.base.index.digest` identifies that image index, not the envelope; a single-manifest source has no index label. `prepare-base` preserves original registry index bytes and intermediate indexes along selected paths, so preparation and repeated preparation keep that identity. For a multi-root layout without a single source index, the envelope is not recorded as an image index.

Matching source index and selected manifest digests do not promise byte-identical final images between registry and layout builds. Registry base-name annotations and provenance describe the source transport, and caller configuration or metadata can differ. Repeatability requires identical effective inputs. Older prepared layouts that replaced the original index cannot recover its digest; prepare them again from the original registry reference.

Rebase accepts the old envelope identity from images built through v0.12.2 only when it matches the verified supplied layout envelope, in addition to matching the manifest, config and layers. Newly produced metadata uses the image identity.
