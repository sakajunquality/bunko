# CLI container

The current container recipe packages the published, checksum-verified JavaScript CLI with pinned Bun 1.4.2, GnuPG's `gpgv`, Git and CA certificates. The published rc.4 reference is `ghcr.io/sakajunquality/bunko:v0.1.0-rc.4`, with verified multiarchitecture index `sha256:54d571385dd58d03f17606aa33f9020847fbb35357ddd8293d90c2c05decd174`. This recipe supports Bun lockfile v2. Pin the published index digest for reproducible consumption. Container publication and source release publication are separate operations.

The image defaults to UID/GID 65532 and includes no Docker daemon or cloud credential helpers. Build inputs can be mounted read-only. `/tmp`, the output directory and the selected cache directory need writable storage; a Docker socket is unnecessary. A source directory must contain the application manifest and lockfile where required.

```sh
mkdir -p output
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  --env HOME=/tmp/bunko-home --env XDG_CACHE_HOME=/tmp/bunko-cache \
  --mount "type=bind,source=$PWD,target=/work,readonly" \
  --mount "type=bind,source=$PWD/output,target=/out" \
  ghcr.io/sakajunquality/bunko:v0.1.0-rc.4 \
  build /work --push=false --oci-layout /out/image --report /out/report.json
```

For publication, supply `--repo` and `--push=true`, and mount a dedicated Docker credential configuration read-only with `DOCKER_CONFIG` pointing to its directory. Use short-lived provider credentials acquired by the outer CI workflow. A configuration referencing `gcloud`, ECR or another external credential helper requires that helper in the builder environment; this image does not silently download helpers. Avoid mounting an entire personal home directory.

Examples:

- [Kubernetes Job](../examples/ci/kubernetes-job.yaml): prepared source/output PVCs, nonroot identity, read-only root filesystem and explicit temporary/cache volumes. Provision the named PVCs and populate the source before running the Job.
- [GitLab CI](../examples/ci/gitlab.yml): shell-compatible entrypoint override and retained layout/report artifacts. The runner must provide a workspace writable by the configured user.
- [Cloud Build](../examples/ci/cloudbuild.yaml): a preparation step creates an output directory owned by UID 65532; source checkout files must remain readable by that user. It does not automatically reuse a host gcloud helper.

These YAML files are configuration examples, not claims of live execution on every CI provider. The repeated container smoke test runs the builder as nonroot with a read-only root filesystem, without a Docker socket, then executes its compiled application separately on Linux amd64 and arm64.

The release workflow explicitly dispatches container packaging after uploading all assets; it does not rely on a release event created by `GITHUB_TOKEN` triggering another workflow. Manual dispatch is also supported on main. Dispatch runs in a separate job so it can be retried without recreating a release. A successful release workflow confirms dispatch, not container publication; check the linked CLI container workflow before using the image. The container uses the reviewed recipe at the dispatched main commit, even when packaging an older CLI release; its attestation records that recipe commit separately from the verified CLI release.

The publication workflow refuses to replace an existing version tag. It validates both platform builders and their compiled applications before pushing, publishes BuildKit SBOM/provenance metadata, generates a GitHub attestation for the image index and verifies the repository, container workflow, source ref and source commit. rc.3's CLI is pinned to its independently verified checksum; later CLI releases require their release provenance bundle.

Verify the published index using its recorded digest and the source ref/commit of the container workflow run:

```sh
gh attestation verify "oci://ghcr.io/sakajunquality/bunko@$IMAGE_DIGEST" \
  --repo sakajunquality/bunko \
  --signer-workflow sakajunquality/bunko/.github/workflows/container.yml \
  --source-ref "$SOURCE_REF" --source-digest "$SOURCE_COMMIT" \
  --deny-self-hosted-runners
```

A Dockerfile builds this tool distribution. Bunko application builds still construct OCI layers directly and do not gain arbitrary RUN or package-manager execution.

## Historical rc.3 validation

[Container workflow 34229522090](https://github.com/sakajunquality/bunko/actions/runs/34229522090) completed publication and exact-source attestation verification on 2026-09-08. The recipe source was `refs/heads/main` at `589564556d67568d163f7e61e67da41cb90698de`; the CLI payload was the checksum-pinned rc.3 release. Both platform builders compiled and executed the dependency fixture before publication. The published index `sha256:96089cd845b26fc8a12c5495b007c7ce76be47617ec6621382fc7e9ad356464e` was then pulled for Linux amd64 and arm64 using an empty Docker credential configuration, and both images returned `0.1.0-rc.3` under nonroot, read-only, network-disabled execution.

## Published rc.4 validation

[Container workflow 34286476774](https://github.com/sakajunquality/bunko/actions/runs/34286476774) completed publication and exact-source attestation verification on 2026-09-09. The recipe source was `refs/heads/main` at `d89fecd854135500e994724573dc58226cae0cdf`; the CLI payload was the attested rc.4 release. Both platform builders generated/frozen-installed a Bun v2 lock, compiled and executed its application before publication. The index above was independently pulled for amd64 and arm64 with an empty Docker credential configuration; both ran `version` successfully with nonroot defaults, a read-only root filesystem, no network and dropped capabilities. See [rc.4 validation](validation/rc4.md) for exact CLI identity and fixture scope.
