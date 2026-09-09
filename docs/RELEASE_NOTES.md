# v0.1.1

Bunko 0.1.1 improves migration diagnostics, build Action inputs and repeated local/CI builds. It also changes the inherited-root default; review that compatibility change before upgrading.

- Install-hook and Bun toolchain errors name the package/hooks or the selected and required versions and declaration sources. Configuration diagnostics report unmatched install-hook allowances.
- Closure builds warn about undeclared package imports. Optional strict mode enforces the importing package's manifest; application-level externalization is a runtime workaround with the advisory policy, not a repair of that declaration.
- Module-location diagnostics suggest declared dependencies to externalize and support `--module-locations=error` / `build.moduleLocations`.
- The build Action accepts `install-cache`, `bare`, `image-user` and `report`; the Dockerfile migration guide maps common build and deployment settings. These inputs require an Action commit containing them; CLI version selection alone does not change an older Action.
- Failed installs include bounded diagnostic tails with credential redaction. Quoted credential keys and expanded npmrc secrets are scrubbed; ambiguous short-secret output is omitted. No install hooks run.
- Bun's package download cache persists by default, separately from layer caches. It is trusted extracted-package input: do not restore untrusted caches into publishing builds. `--no-local-cache` without an explicit install-cache retains temporary staging.
- Reports can atomically replace recognizable prior Bunko reports (at most 32 MiB). Other existing files, symlinks and declared input paths are protected. Check the command exit code: a very early failure may leave a previous report in place. Secondary report-write errors preserve the original failure.

## Migration from 0.1.0

An inherited base user of root or numeric UID 0, including zero-padded forms such as `00:00`, now defaults to `65532:65532`. Other nonroot base users are inherited. Explicit `bunko.user` / `--image-user` values remain authoritative; set `0:0` explicitly only for applications that require root. This changes image digests and can affect file access or low-port binding. Test startup and filesystem access with the selected base.

Review [compatibility](https://github.com/sakajunquality/bunko/blob/v0.1.1/docs/COMPATIBILITY.md) and the [Dockerfile migration guide](https://github.com/sakajunquality/bunko/blob/v0.1.1/docs/MIGRATING_FROM_DOCKERFILE.md). Bun >=1.3.11 <1.5 is supported on Linux/macOS x64 and arm64; compile/runtime injection require gpgv. npm installation does not install Bun or run lifecycle hooks.

GitHub CLI, npm package and official container publication are separate gates. Exact source identities and consumer results are recorded in the [0.1.1 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.1.1.md). Existing versions and assets remain immutable. Setup defaults are promoted only after independent verification; the immutable v0.1.1 Action tag retains preparation-time defaults, so select the CLI version explicitly.

Private ECR and the external application-machine acceptance matrix remain unverified; the separate private GHCR application rerun is still blocked by account billing. musl and rebase remain tracked in issues #53 and #54. Marketplace publication and setup Action separation are not part of this release.
