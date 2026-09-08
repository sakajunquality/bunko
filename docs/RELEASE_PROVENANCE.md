# Release artifact provenance

Release workflows after rc.3 attest the prepared CLI, checksum manifest, license and third-party notices with GitHub's Sigstore-backed artifact attestations. rc.3 and earlier releases have no retroactive attestation and retain their immutable assets. `PROVENANCE.jsonl` is a signed bundle; its signature binds the release payload digests, so it is not added to the checksum manifest it signs.

A separate job downloads the prepared artifacts and verifies each subject against the repository, `.github/workflows/release.yml`, exact source ref and source commit, and GitHub-hosted runners before publication. Manual validation runs are restricted to main; their attestations identify `refs/heads/main` and must not be accepted as version-tag attestations.

Install a current GitHub CLI, download all release assets, then verify a particular attested version before running its CLI:

```sh
version=v0.1.0-rc.4 # Replace with a published, attested version.
sha256sum --check SHA256SUMS
gh attestation verify bunko.js --bundle PROVENANCE.jsonl \
  --repo sakajunquality/bunko \
  --signer-workflow sakajunquality/bunko/.github/workflows/release.yml \
  --source-ref "refs/tags/$version" --deny-self-hosted-runners
```

A valid digest alone is insufficient: retain the repository, workflow and tag constraints. Use `--source-digest` with a separately trusted commit for additional pinning. The setup Action exposes `verify-attestation: 'true'`, requires `gh`, verifies all payloads before executing the downloaded CLI and fails if the signed bundle is absent or verification fails. It defaults to false for compatibility with earlier immutable releases. Do not enable it for rc.3 or earlier. The checksum-only installation path remains available for those versions.

Attestations establish origin and integrity, not a guarantee that the source or compiler is safe. The signing workflow and its pinned build dependencies are part of the trust boundary. The application-image provenance emitted by `bunko build --provenance` is a separate artifact.

See [GitHub artifact attestation guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) and the [GitHub CLI verification options](https://cli.github.com/manual/gh_attestation_verify).
