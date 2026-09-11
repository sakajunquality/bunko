# CLI container

The current container recipe packages the published, checksum-verified JavaScript CLI with pinned Bun 1.4.2, GnuPG's `gpgv`, Git and CA certificates. The published 0.7.0 reference is `ghcr.io/sakajunquality/bunko:v0.7.0`, with verified multiarchitecture index `sha256:b613415203c9c73bcdc5544fa355d07a059e5725368861672a8b00c0fe46bc79`. This recipe supports Bun lockfile v2. Pin the published index digest for reproducible consumption. Container publication and source release publication are separate operations.

The image defaults to UID/GID 65532 and includes no Docker daemon or cloud credential helpers. Build inputs can be mounted read-only. `/tmp`, the output directory and the selected cache directory need writable storage; a Docker socket is unnecessary. A source directory must contain the application manifest and lockfile where required.

```sh
mkdir -p output
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  --env HOME=/tmp/bunko-home --env XDG_CACHE_HOME=/tmp/bunko-cache \
  --mount "type=bind,source=$PWD,target=/work,readonly" \
  --mount "type=bind,source=$PWD/output,target=/out" \
  ghcr.io/sakajunquality/bunko@sha256:b613415203c9c73bcdc5544fa355d07a059e5725368861672a8b00c0fe46bc79 \
  build /work --push=false --oci-layout /out/image --report /out/report.json
```

For publication, supply `--repo` and `--push=true`, and mount a dedicated Docker credential configuration read-only with `DOCKER_CONFIG` pointing to its directory. Use short-lived provider credentials acquired by the outer CI workflow. A configuration referencing `gcloud`, ECR or another external credential helper requires that helper in the builder environment; this image does not silently download helpers. Avoid mounting an entire personal home directory.

Examples:

- [Kubernetes Job](../examples/ci/kubernetes-job.yaml): prepared source/output PVCs, nonroot identity, read-only root filesystem and explicit temporary/cache volumes. Provision the named PVCs and populate the source before running the Job.
- [GitLab CI](../examples/ci/gitlab.yml): shell-compatible entrypoint override and retained layout/report artifacts. The runner must provide a workspace writable by the configured user.
- [Cloud Build](../examples/ci/cloudbuild.yaml): a preparation step creates an output directory owned by UID 65532; source checkout files must remain readable by that user. It does not automatically reuse a host gcloud helper.

These YAML files are configuration examples, not claims of live execution on every CI provider. The repeated container smoke test runs the builder as nonroot with a read-only root filesystem, without a Docker socket, then executes its compiled application separately on Linux amd64 and arm64.

The release workflow explicitly dispatches container packaging after uploading all assets; it does not rely on a release event created by `GITHUB_TOKEN` triggering another workflow. Manual dispatch is also supported on main. Dispatch runs in a separate job so it can be retried without recreating a release. A successful release workflow confirms dispatch, not container publication; check the linked CLI container workflow before using the image. The container uses the reviewed recipe at the dispatched main commit, even when packaging an older CLI release; its attestation records that recipe commit separately from the verified CLI release.

The publication workflow refuses to replace an existing version tag. It uploads a candidate by digest with BuildKit SBOM/provenance metadata, validates both platform builders and their compiled applications, generates and verifies the GitHub index attestation against the repository/workflow/source identity, then promotes those unchanged bytes to the version tag. rc.3's CLI is pinned to its independently verified checksum; later CLI releases require their release provenance bundle.

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

[Container workflow 34286476774](https://github.com/sakajunquality/bunko/actions/runs/34286476774) completed publication and exact-source attestation verification on 2026-09-09. The recipe source was `refs/heads/main` at `d89fecd854135500e994724573dc58226cae0cdf`; the CLI payload was the attested rc.4 release. Both platform builders generated/frozen-installed a Bun v2 lock, compiled and executed its application before publication. The rc.4 index `sha256:54d571385dd58d03f17606aa33f9020847fbb35357ddd8293d90c2c05decd174` was independently pulled for amd64 and arm64 with an empty Docker credential configuration; both ran `version` successfully with nonroot defaults, a read-only root filesystem, no network and dropped capabilities. See [rc.4 validation](validation/rc4.md) for exact CLI identity and fixture scope.

## Published rc.5 validation

[Container workflow 34308988320](https://github.com/sakajunquality/bunko/actions/runs/34308988320) validated, attested and promoted index `sha256:ce1cb4515ae18c52b219f3d39b2e8b32783dce66f680b90c3ec7d1a03fd22e30` from recipe commit `aebb1697329c02170631fb4c538a8b276feb5769`. Independent exact-source attestation verification, anonymous pulls and nonroot, read-only, network-disabled execution passed for both architectures. Both in-image CLI hashes match the published rc.5 JavaScript. See [rc.5 evidence](validation/rc5.md).

## Published 0.1.0 validation

[Container workflow 34318353999](https://github.com/sakajunquality/bunko/actions/runs/34318353999) validated and promoted the 0.1.0 index `sha256:1f31e7756fb93926de29b2fce46b5070e35d268b7c48415d27d10725c5e1a8e9` from recipe source `72d9ac859fd1c499c2d1856a11891101f25f99df`. Both platform builders compiled and ran the application before publication. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and in-image CLI hash comparison passed on amd64 and arm64. See [0.1.0 evidence](validation/v0.1.0.md).

## Published 0.1.1 validation

[Container workflow 34354019145](https://github.com/sakajunquality/bunko/actions/runs/34354019145) validated and promoted the 0.1.1 index `sha256:9adf1365ed09a2067d839819f041cd4dfe52fde6cfee735390edf2876e7afee8` from recipe source `d060057d7831da8dff65bc762abbbffab4ee3879`. Both platform builders compiled and ran the application before publication. Independent exact-source index attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and in-image CLI hash comparison passed on amd64 and arm64. The CLI hash matches the signed GitHub 0.1.1 release. See [0.1.1 evidence](validation/v0.1.1.md).

## Published 0.1.2 validation

[Container workflow 34417350016](https://github.com/sakajunquality/bunko/actions/runs/34417350016) validated and promoted the 0.1.2 index `sha256:374f60f864226e03dc3eb47fcc3bd57954f148a200e6c5f4722ad0e50c4e3393` from recipe source `bed0ac61fba055c84212cd4a09e9dd4f13b5f6dd`. Both platform builders compiled and ran their application before publication. Independent exact-source index attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and in-image CLI hash comparison passed on amd64 and arm64. Both in-image CLI hashes match the signed GitHub 0.1.2 release. See [0.1.2 evidence](validation/v0.1.2.md).

## Published 0.1.3 validation

[Container workflow 34432539667](https://github.com/sakajunquality/bunko/actions/runs/34432539667) validated and promoted the 0.1.3 index `sha256:ea4edd5f47f9dd0c8e584409370784fa5936cb8d487ac8badbdc6863b5635f54` from recipe source `329286645a118d5c7a4f468c98fc3f970dc1c40c`. Both platform builders compiled and ran their application before publication. Independent exact-source index attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and in-image CLI hash comparison passed on amd64 and arm64. Both in-image CLI hashes match the signed GitHub 0.1.3 release. See [0.1.3 evidence](validation/v0.1.3.md).

## Published 0.1.4 validation

[Container workflow 34437338920](https://github.com/sakajunquality/bunko/actions/runs/34437338920) validated and promoted the 0.1.4 index `sha256:0f550c7c5aef48fce3886ba5cc7805d5b0aba85f89b4dcba6b581c45d9e6813d` from recipe source `c521995c68d10c6e5a0d87d9933b0486209f7b70`. Both platform builders compiled and ran their application before publication. Independent exact-source index attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and in-image CLI hash comparison passed on amd64 and arm64. Both in-image CLI hashes match the signed GitHub 0.1.4 release. See [0.1.4 evidence](validation/v0.1.4.md).

## Published 0.2.0 validation

[Container run 34441528824](https://github.com/sakajunquality/bunko/actions/runs/34441528824) published index `sha256:b314b744103db075ccc9b787cce0a740a98c6edf2ce7740762a6972893411f47` from source `e3644475fecfae587db11a8c7dca229dbd6c4ca1`. Independent exact-source attestation, anonymous pulls and nonroot/read-only/network-disabled execution passed on amd64 and arm64. Both in-image CLI hashes match the signed GitHub release. See [0.2.0 evidence](validation/v0.2.0.md).


## Published 0.3.0 validation

[Container workflow 34446574166](https://github.com/sakajunquality/bunko/actions/runs/34446574166) validated, attested and promoted index `sha256:5bc819edba84d1236d42bde60a5cc2a2d147c37525318141251bec5a6d210dea` from recipe source `c75a6c815553ac0502addbeb69f7f449f9e04e91`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.3.0 evidence](validation/v0.3.0.md).


## Published 0.3.1 validation

[Container workflow 34453811498](https://github.com/sakajunquality/bunko/actions/runs/34453811498) validated, attested and promoted index `sha256:4e53278d95cacb1e025dee01bc6bfedcb53bb0ab521399398e185263bd477644` from recipe source `9f86e18f06c61272854c752a542d40c6d29600ca`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.3.1 evidence](validation/v0.3.1.md).

## Published 0.3.2 validation

[Container workflow 34466016363](https://github.com/sakajunquality/bunko/actions/runs/34466016363) validated, attested and promoted index `sha256:f3575f26a2c90aee2655658e73e0690350f3dce5b4c16bded0ff032807692df5` from recipe source `f50923f49d8889857b1e5769b15c234b7cfb8095`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.3.2 evidence](validation/v0.3.2.md).

## Published 0.4.0 validation

[Container workflow 34477435941](https://github.com/sakajunquality/bunko/actions/runs/34477435941) validated, attested and promoted index `sha256:4d48a39f82b4df14fe71236a047ef977cb3c733a95d00431e8890ab1687f53c1` from recipe source `0492630c520d4d9608e1fa41494568c00b09a7d9`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.4.0 evidence](validation/v0.4.0.md).

## Published 0.5.0 validation

[Container workflow 34497997417](https://github.com/sakajunquality/bunko/actions/runs/34497997417) validated, attested and promoted index `sha256:822568df340c3491ab69635bdf7d63b8a315a75443c16fed7a62e62e2425581f` from recipe source `45f2daab119ed5d378f315c75afb73b322014086`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.5.0 evidence](validation/v0.5.0.md).

## Published 0.6.0 validation

[Container workflow 34545935367](https://github.com/sakajunquality/bunko/actions/runs/34545935367) validated, attested and promoted index `sha256:3f810a26ea2aedfab38b22a0b659828ff636a3ad66f0feadc17e149fb1367edd` from recipe source `e5b96c59cecef2f4ed3fd69a1d7fabb219df4c28`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.6.0 evidence](validation/v0.6.0.md).


## Published 0.6.1 validation

[Container workflow 34551869035](https://github.com/sakajunquality/bunko/actions/runs/34551869035) validated, attested and promoted index `sha256:9372917d18b3787782d67f6a104f4f2faffecd97bf8b1f320f4e52675d90f761` from recipe source `965bbce218c935e29cfb2d87e00b733dbcbf86b1`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.6.1 evidence](validation/v0.6.1.md).


## Published 0.6.2 validation

[Container workflow 34559147568](https://github.com/sakajunquality/bunko/actions/runs/34559147568) validated, attested and promoted index `sha256:e597562078a86d7982d0e0578c16f36e0a485c4dfc0c1f078abc8c49fda805c2` from recipe source `ab6d35eb7c39369b1c2491c4b94c20e656b4548b`. Independent exact-source attestation verification, anonymous pulls, nonroot/read-only/network-disabled execution and CLI hash comparison passed on Linux amd64 and arm64. See [0.6.2 evidence](validation/v0.6.2.md).
