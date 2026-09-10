# v0.2.0 (unreleased)

The CLI process itself must run on a supported Bun version, including for diagnostics and `version`. `--bun-path` selects the build toolchain; it does not replace the Bun interpreter running the CLI.

Bunko now requires stable Bun >=1.3.13 <1.5. Bun 1.3.11 and 1.3.12 are no longer supported for running the CLI, selected build toolchains, or verified compile/injection runtimes. Upgrade Bun and update any exact `packageManager` or `bunko.toolchain.version` pins. Users who need the older toolchains can pin `@sakajunquality/bunko@0.1.4` or the v0.1.4 setup Action. Published 0.1.4 assets remain unchanged.

CI covers Bun 1.3.13, 1.4.0 and 1.4.2 on Linux and macOS; release preparation uses 1.3.13. Verified runtime pins cover 1.3.13 and 1.4.0–1.4.2. Bun 1.5 and prereleases remain outside the supported range.

# v0.1.4

Bunko 0.1.4 fixes compatibility with ko-published images used as bases or image asset sources.

- Platform descriptors carrying an OCI or Docker image-config `artifactType` are now selectable. Non-image artifact types remain excluded; the selected manifest's actual config media type and platform are still validated.
- Layer entry names with leading `/` or `./` prefixes are normalized to container-root-relative paths. This accepts ko paths such as `/ko-app/spannerdef` while still rejecting traversal, interior empty/dot segments, backslashes, control characters and excessive path size/depth.
- The documented `--asset-cache` option is now accepted by build, resolve and apply; it previously failed command-option validation.
- Invalid-path diagnostics identify the offending entry with bounded, escaped output. Regression checks cover attestation filtering, config validation and image link resolution.

The public spannerdef image was independently checked on linux/amd64 and linux/arm64: each platform binary was extracted and executed inside a nonroot, read-only container with no network and dropped capabilities. This validates that public fixture, not every ko/BuildKit image or external application.

See [image source compatibility](https://github.com/sakajunquality/bunko/blob/v0.1.4/docs/APPLICATION_COMPATIBILITY.md#image-and-url-asset-sources) and the [0.1.4 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.1.4.md). Bun >=1.3.11 <1.5 remains supported; npm does not install Bun. Existing image-asset restrictions, including selected symlink/hardlink rejection, remain unchanged. External application-machine acceptance and private ECR remain unverified; musl/rebase and setup Action separation/Marketplace publication remain outside this release.
