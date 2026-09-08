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
  - uses: sakajunquality/bunko@main # Pin to a reviewed commit.
    with:
      version: v0.1.0-rc.3
  - name: Authenticate to GHCR
    env:
      GHCR_TOKEN: ${{ github.token }}
    run: printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
  - uses: sakajunquality/bunko/build@main # Pin to the same reviewed commit.
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

For pull requests without publication, omit `repo`, `push` and write permissions. The default is `push: 'false'`, and the Action exports a local OCI layout. Upload `${{ steps.image.outputs.layout }}` and `${{ steps.image.outputs.report }}` with your artifact retention policy. Reports may be absent for failures before build preparation; upload with an explicit missing-file policy. Build scripts do not require a Docker daemon. The authentication example uses Docker's credential configuration, not its daemon.

The `images` output is a JSON array containing every selected target, its root digest and a published reference when available. `digest` and `reference` are populated only for exactly one target; they are empty for multi-target builds. `report` points to the detailed build report. `image-refs` is the successful immutable reference file for published builds. `layout` is set for local-only builds or when `export-layout: 'true'` is requested. Publishing without layout export preserves lazy base-layer transfers. Failed builds expose no successful image outputs; the report, when written, retains the underlying failure/partial-publication state.

Inputs include comma-separated `platforms`, and newline-separated `targets`, `tags`, `cache-from` and `asset-contexts`. `base`, `base-layout`, `runtime-inject`, `mode`, `cache-dir`, `cache-repo` and `cache-write` map to their CLI counterparts. Use package configuration for application settings and the CLI directly for options outside the Action's input surface. No input is evaluated by a shell. Setup and build are separate steps so credential helpers and `gpgv` can be installed explicitly when required.

To export telemetry, set `otel: 'true'` and configure the supported `OTEL_*` environment variables on the build step. Keep authenticated exporter headers in secrets and use HTTPS. No telemetry is enabled just because environment variables are present. See [telemetry](TELEMETRY.md).

Persist a local `cache-dir` with your CI cache service, or use explicit registry cache repositories. Cache keys should separate operating systems and Bun versions; Bunko validates its own content keys before reuse. Do not expose write credentials to untrusted pull requests. Use provider OIDC login steps for Artifact Registry or ECR, or a Docker Hub access token via `docker login`; see [registry authentication](REGISTRIES.md). Provider helper binaries are the workflow's responsibility.

The setup default is rc.3 after its published bytes were verified against the tested candidate. Attestation verification is opt-in and applies only to future attested releases; see [release provenance](RELEASE_PROVENANCE.md).
