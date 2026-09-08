# v0.1.0-rc.4

This release adds Bun 1.4 support, source-preserving builds, CI distribution and runtime configuration to the rc.3 foundation.

- Accept stable Bun >=1.3.11 <1.5 and text lockfile versions 1 and 2. Version 2 requires a selected Bun >=1.4.0; an older toolchain fails before installation or registry access. Compile/runtime injection use signature-verified, pinned official Bun 1.3.11–1.3.13 and 1.4.0–1.4.2 archives. See [Bun 1.4 migration](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.4/docs/COMPATIBILITY.md#bun-14-migration-rc4-and-later).
- Package sanitized source with `--mode source`, frozen Linux production dependencies and runtime module resolution. Add explicit workspace defaults, toolchain declarations, runtime arguments, asset exclusions/modes and application CA certificates. See [configuration](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.4/docs/CONFIGURATION.md).
- Add invocation-level defines, proxy/npm CA handling, pull-only registry mirrors, prepared local bases and bounded offline builds. These controls retain explicit credential and trust boundaries.
- Map font data and notices into approved system font directories. Runnable Canvas CJK/color emoji and Resvg CJK examples cover fontconfig and explicit-directory discovery in bundle/source modes on both Linux architectures. See [fonts](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.4/docs/FONTS.md).
- Include the build GitHub Action and CLI container recipe using pinned Bun 1.4.2. Container publication follows the release in a separate workflow; wait for it to complete before using the versioned image.
- Publish `PROVENANCE.jsonl` with GitHub attestations for the CLI, checksum manifest and notices. A separate consumer job verifies exact source identity before publication. The setup Action supports opt-in attestation verification. Earlier releases remain immutable and do not gain provenance bundles.

The JavaScript CLI still requires Bun. Compile/runtime injection require `gpgv`; supported Linux targets are glibc amd64/arm64. Existing bases are not automatically upgraded when the host Bun changes. Native dependencies may require a compatible custom base; Bunko does not execute OS package managers or arbitrary RUN instructions. OpenTelemetry remains explicitly opt-in.

[rc.4 candidate validation](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.4/docs/validation/rc4.md) identifies the exact tested payload and fixture coverage. Generic fixtures do not certify external workloads or every registry. Historical cloud interoperability evidence is not attributed to this RC; private ECR remains unverified. Stable release promotion still requires applicable remote workload acceptance.
