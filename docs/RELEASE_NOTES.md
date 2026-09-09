# v0.1.0

The first stable Bunko release builds OCI images from Bun applications without a Dockerfile or Docker daemon. It promotes the rc.5 application build behavior and adds the verified npm distribution workflow; this release introduces no new application build features.

- Build standalone projects and Bun workspaces in bundle, source or compile mode, targeting Linux glibc amd64 and arm64.
- Use signed Bun runtime injection, dependency and asset caches, local OCI layouts, image publication, and YAML/JSON image-reference resolution.
- Configure registry credentials, prefixed mirrors, bounded transfer recovery, tag-conflict handling, SPDX inventories, provenance and optional cosign signing.
- Export opt-in OpenTelemetry traces and metrics. Package declared runtime CA certificates and font assets within the documented trust boundaries.
- Install the same JavaScript CLI through GitHub releases, the setup Action or `@sakajunquality/bunko`. The official CLI container is published and verified separately. npm publication uses the reviewed tarball and GitHub Actions trusted publishing.

The CLI requires Bun >=1.3.11 <1.5 on Linux or macOS (x64 or arm64). CI covers Bun 1.3.11, 1.3.12, 1.3.13, 1.4.0 and 1.4.2. Compile/runtime injection require `gpgv`. npm installation does not install Bun or run lifecycle hooks.

Stable release status does not expand the supported scope. musl and rebase remain tracked in issues #53 and #54. Private ECR and the separate application-machine acceptance matrix remain unverified. The private GHCR application conformance rerun is blocked by an account billing restriction; public official-container checks and historical GHCR results are separate evidence. Independent referrer-tag publishers require external coordination, and SPDX generation is opt-in outside explicit CI policy. See the [recheck disposition](https://github.com/sakajunquality/bunko/blob/v0.1.0/docs/RECHECK.md).

For upgrades from rc.4 or earlier, review the [rc.5 migration notes](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.5/docs/RELEASE_NOTES.md): source filtering and layer/base metadata rules can change image identities and cause cold caches.

Existing rc.5 and older releases remain immutable. GitHub CLI release, npm package and official container publication are separate operations: their source identities and consumer verification are recorded in the [0.1.0 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.1.0.md). Setup defaults are promoted after the new published artifacts pass verification. The immutable v0.1.0 Action tag retains its preparation-time defaults; pass the desired CLI version explicitly.
