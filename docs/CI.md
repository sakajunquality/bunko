# Building in CI

Install Bunko, configure registry authentication explicitly, then run the build Action. The build Action lives at `sakajunquality/bunko/build`; pin both Actions to a reviewed commit containing it. The immutable rc.3 tag includes the setup Action but predates the build Action.

```yaml
permissions:
  contents: read
  packages: write
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    with:
      persist-credentials: false
  - uses: sakajunquality/bunko@c521995c68d10c6e5a0d87d9933b0486209f7b70
    with:
      bun-version: 1.4.2
      verify-attestation: 'true'
  - name: Authenticate to GHCR
    env:
      GHCR_TOKEN: ${{ github.token }}
    run: printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
  - uses: sakajunquality/bunko/build@c521995c68d10c6e5a0d87d9933b0486209f7b70
    id: image
    with:
      path: .
      repo: ghcr.io/${{ github.repository_owner }}/applications
      platforms: linux/amd64,linux/arm64
      push: 'true'
      targets: |
        services/api
        services/worker
```

For pull requests without publication, omit `repo`, `push` and write permissions. The default is `push: 'false'`, and the Action exports a local OCI layout. Upload `${{ steps.image.outputs.layout }}` and `${{ steps.image.outputs.report }}` with your artifact retention policy. Reports may be absent for failures before build preparation; upload with an explicit missing-file policy. A re-run on the same runner path replaces an earlier report atomically; a failure before report creation leaves the earlier file, so the process exit code is authoritative: neither an existing file nor a success status proves this invocation succeeded. Build scripts do not require a Docker daemon. The authentication example uses Docker's credential configuration, not its daemon.

The `images` output is a JSON array containing every selected target, its root digest and a published reference when available. `digest` and `reference` are populated only for exactly one target; they are empty for multi-target builds. `report` points to the detailed build report. `image-refs` is the successful immutable reference file for published builds. `layout` is set for local-only builds or when `export-layout: 'true'` is requested. Publishing without layout export avoids writing an exported layout; build-time base filesystem validation still reads the selected base layers. Failed builds expose no successful image outputs; the report, when written, retains the underlying failure/partial-publication state.

Inputs include comma-separated `platforms`, and newline-separated `targets`, `tags`, `cache-from` and `asset-contexts`. `base`, `base-layout`, `runtime-inject`, `mode`, `cache-dir`, `cache-repo`, `cache-write`, `install-cache` and `image-user` map to their CLI counterparts, and `bare: 'true'` passes `--bare` (exactly one target). `report` selects the build report path instead of the default file in the runner temporary directory; the `report` output returns whichever path was used, and CLI 0.1.0 refuses an existing file; 0.1.1 replaces a recognizable prior Bunko report while protecting other existing files. These four inputs require an Action commit that includes them. Use package configuration for application settings and the CLI directly for options outside the Action's input surface. No input is evaluated by a shell. Setup and build are separate steps so credential helpers and `gpgv` can be installed explicitly when required.

To export telemetry, set `otel: 'true'` and configure the supported `OTEL_*` environment variables on the build step. Keep authenticated exporter headers in secrets and use HTTPS. No telemetry is enabled just because environment variables are present. See [telemetry](TELEMETRY.md).

Persist a local `cache-dir` with your CI cache service, or use explicit registry cache repositories. Persist `install-cache` separately for package downloads; in CLI 0.1.1 its default is `${XDG_CACHE_HOME:-~/.cache}/bunko/install/v1`. Inputs are not shell-expanded, so write cache paths without `~`, for example `${{ runner.temp }}/bunko/cache`. Cache keys should separate operating systems and Bun versions; Bunko validates its own content keys before reuse. Do not expose write credentials to untrusted pull requests. Use provider OIDC login steps for Artifact Registry or ECR, or a Docker Hub access token via `docker login`; see [registry authentication](REGISTRIES.md). Provider helper binaries are the workflow's responsibility.

Replacing a Dockerfile and docker/build-push-action is covered instruction by instruction in [migrating from a Dockerfile](MIGRATING_FROM_DOCKERFILE.md).

When `version` is omitted, setup uses its own `uses:` ref only if the Action repository matches the configured release repository: a version-shaped ref such as `v0.1.4` installs that CLI version, and any other ref, including a branch or commit pin, installs the release recorded in that checkout's `package.json`, a ref from a different repository also falls back to the checkout version. An explicit `version` always overrides automatic resolution. Branch and commit pins require the checkout version to have a published release; during release preparation, explicitly select an already published version. `bun-version` has no such source and stays explicit. Action commits cut before this resolution existed, including the immutable `v0.1.2` tag, keep their hard-coded CLI default of 0.1.1; keep `version` explicit when pinning those. See [version resolution](RELEASING.md#use-the-setup-action). Attestation verification is opt-in and is available for rc.4 and later; see [release provenance](RELEASE_PROVENANCE.md).

## Diagnostic output

`check-config` and `doctor` keep their single-line JSON whenever stdout is not a terminal. The choice depends on stdout alone: a pipe or a redirect produces JSON regardless of stderr or environment variables, so steps such as `bunko check-config . | jq -r .status` are unaffected, while a runner that allocates a pseudo-terminal for the step receives the text summary instead. Pass `--format json` wherever the output is parsed, and `--format text` for a readable summary in a local terminal or a job log.

## Invocation constants

rc.4 and later accept repeatable `--define KEY=VALUE` on build, resolve, apply, check-config and doctor. CLI values override the matching `bunko.build.define` entries for this invocation; other configured entries remain in effect. In a workspace, invocation defines apply to every selected target. Each key must be an identifier or dotted key and each value must be explicit. Duplicate CLI keys and shorthand environment lookups are rejected.

```sh
bunko build . --define 'BUILD_VERSION="1.2.3"' \
  --define 'process.env.FEATURE_ENABLED=true' --repo registry.example/team
```

Values use Bun's define expression syntax; quote strings as JavaScript literals and quote the whole argument for your shell. Effective values enter application cache keys and change the embedded application. Reports and telemetry do not include a define-value field; offline diagnostics list only keys. Defines are not a secret channel: their values are intentionally embedded in artifacts and build diagnostics may describe invalid expressions. Keep runtime secrets in runtime configuration instead. The immutable rc.3 CLI does not include this option.


The CLI container publication workflow builds the amd64/arm64 index once and pushes it by digest without a version tag. It pulls that candidate for both platform smoke tests, verifies the generated applications, and verifies the index provenance before promoting the exact index bytes to the release tag. BuildKit SBOM/provenance descriptors remain in the index. A failed candidate can leave untagged registry content until an operator or registry retention policy removes it; automatic garbage collection is not assumed. A failed candidate does not publish a release tag.

All container publication runs share one concurrency group, including version inputs with and without the `v` prefix. Promotion refuses existing version tags and checks the published digest. The existence check is not a registry compare-and-swap operation: restrict other writers to the release repository. Release tags and existing releases must not be overwritten.

The Dockerfile pins its Bun base and installs Debian packages from the signed snapshot in `container/debian.sources`. Advance both pins together for security updates. Only the snapshot's expiry check is disabled; Debian signature/package verification and HTTPS remain enabled. Fixed package inputs avoid drifting dependencies but do not by themselves promise bit-for-bit Dockerfile rebuilds. The revision label identifies the container recipe checkout; CLI release provenance independently identifies the downloaded CLI payload source.
