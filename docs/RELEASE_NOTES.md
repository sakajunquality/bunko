# v0.1.0-rc.3

This candidate adds opt-in build observability and verifies the Bun release runtime embedded by compile mode.

- Export bounded OpenTelemetry traces and metrics using `--otel` and OTLP/HTTP JSON. No telemetry is sent without explicit opt-in. Export failures preserve the build result; exporter headers require HTTPS. See [telemetry](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.3/docs/TELEMETRY.md) for the supported configuration and data contract.
- Reject compile builds that emit additional HTML, CSS or client assets rather than deleting files still referenced by the server. Use bundle mode for those applications. Literal dynamic imports included in a single server output remain supported.
- Embed the signature-verified, pinned official Linux Bun release via `--compile-executable-path`. Compile now requires `gpgv` and an official Bun 1.3.11, 1.3.12 or 1.3.13 revision. Runtime input identities enter cache keys, reports, SBOM and provenance; licensing and source notices accompany the compiled application.
- Honor `build.minify` in compile mode. External compile sourcemaps and bytecode remain unsupported.
- Default the image's runtime transpiler cache to disabled when the base does not declare a setting. Explicit base and application overrides remain supported.

## Compatibility and validation

Existing compile users with other Bun patches or custom builds must select a supported official release. General bundle builds retain the Bun >=1.3.11 <1.4 contract. The CI matrix covers Linux/macOS and Bun 1.3.11–1.3.13. Compile runtime validation covers dynamic imports, deterministic output, authenticated full revision identity, both Linux architectures, nonroot and read-only execution.

Collector, runtime-injection and generic application fixtures provide repeatable acceptance checks. They do not certify external application behavior; remote workload acceptance and unavailable provider credentials remain separate. Follow the [remote acceptance checklist](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.3/docs/validation-request.html). Registry interoperability evidence from earlier releases is not automatically attributed to rc.3. Private ECR remains unverified.

The distribution contains the JavaScript CLI, SHA256SUMS, MIT license and third-party notices. npm publication is not included. Earlier tags and assets remain immutable. Rebuild compiled images when upgrading; the additional runtime inputs and notices change application cache keys and image digests.

The transpiler cache default changes image configuration digests in every mode when the base does not already declare the setting. Existing explicit settings are preserved.
