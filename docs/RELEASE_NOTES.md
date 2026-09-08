# v0.1.0-rc.1

This release candidate expands compatibility with existing Bun applications and adds a repeatable application acceptance workflow.

- Bundle only loaded executable inputs, with pre-execution macro checks and explicit data imports. Copied frontend assets and unreachable dependencies no longer receive executable syntax checks.
- Support workspace catalogs, selected application compiler configuration, and a restricted install-only bunfig contract.
- Allow explicitly reviewed dependency install hooks to be ignored (never executed), and opt into unresolved dependency expressions when runtime resolution is required.
- Bundle named server, worker and migration entries into one image with an overridable default command.
- Map selected named local asset inputs to image destinations, including generated files outside the project.
- Optionally suppress inherited base OCI labels. This is not an anonymization feature.
- Diagnose named entries and external asset bindings before building. Add a disposable HTTP/PostgreSQL/native-addon acceptance fixture and an exact-identifier output gate.

## Migration and validation boundaries

The existing single-entry image contract remains unchanged. Named entries require bundle mode and use `Entrypoint=[bun]`; select another entry using its emitted path from `images[].entrypoints`. Config diagnostics now require bindings for declared external assets. Build frontend and workflow bundles before invoking Bunko, declare runtime files explicitly, and adapt location-sensitive file reads for bundled output.

Source-preserving mode and automatic Bun injection into arbitrary bases are not implemented. Prepared bases must already include Bun and the required ABI/shared libraries. Allowing ignored scripts or unresolved dependency expressions does not establish native runtime compatibility.

The generic acceptance fixture checks PostgreSQL migration and a database task worker, HTTP/static content, exact runtime file content, a native hash operation, non-root/read-only execution and graceful server shutdown. It does not establish React Router, Temporal, Slack or Snowflake workload compatibility. Remote application validation remains required before stable release; use [the acceptance guide](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.1/docs/APPLICATION_VALIDATION.md).

Bun >=1.3.11 <1.4 is required. CI covers 1.3.11, 1.3.12 and 1.3.13 on Linux/macOS. The distribution includes the standalone JavaScript CLI, SHA256SUMS, MIT license and third-party notices; npm publication is not part of this release.

GHCR, Artifact Registry, Docker Hub and authenticated upstream evidence in [published release validation](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.1/docs/PUBLISHED_RELEASE_VALIDATION.md) belongs to alpha.2, not this RC. Private ECR remains unverified. Existing tags and release assets are immutable.
