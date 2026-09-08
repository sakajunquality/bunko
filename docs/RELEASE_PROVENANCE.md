# Release artifact provenance

rc.4 and later release workflows attest the prepared CLI, checksum manifest, license and third-party notices with GitHub's Sigstore-backed artifact attestations. rc.3 and earlier releases have no release-tag provenance bundle and retain their immutable assets. `PROVENANCE.jsonl` is a signed bundle; its signature binds the release payload digests, so it is not added to the checksum manifest it signs.

A separate job downloads the prepared artifacts and verifies each subject against the repository, `.github/workflows/release.yml`, exact source ref and source commit, and GitHub-hosted runners before publication. Manual validation runs are restricted to main; their attestations identify `refs/heads/main` and must not be accepted as version-tag attestations.

Install a current GitHub CLI, download all release assets, then verify a particular attested version before running its CLI:

```sh
version=v0.1.0-rc.4
sha256sum --check SHA256SUMS
gh attestation verify bunko.js --bundle PROVENANCE.jsonl \
  --repo sakajunquality/bunko \
  --signer-workflow sakajunquality/bunko/.github/workflows/release.yml \
  --source-ref "refs/tags/$version" --deny-self-hosted-runners
```

A valid digest alone is insufficient: retain the repository, workflow and tag constraints. Use `--source-digest` with a separately trusted commit for additional pinning. The setup Action accepts an optional `source-commit` full digest to pin the attested source. Verification failures use a fixed diagnostic; run the explicit verification command above to investigate tool or trust-root configuration. The setup Action exposes `verify-attestation: 'true'`, requires `gh`, verifies all payloads before executing the downloaded CLI and fails if the signed bundle is absent or verification fails. It defaults to false for compatibility with earlier immutable releases. Do not enable it for rc.3 or earlier. The checksum-only installation path remains available for those versions.

Attestations establish origin and integrity, not a guarantee that the source or compiler is safe. The signing workflow and its pinned build dependencies are part of the trust boundary. The application-image provenance emitted by `bunko build --provenance` is a separate artifact.

See [GitHub artifact attestation guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) and the [GitHub CLI verification options](https://cli.github.com/manual/gh_attestation_verify).

## Live verification

[Workflow run 34226876341](https://github.com/sakajunquality/bunko/actions/runs/34226876341) generated real GitHub attestations on main at `944929d` and verified all downloaded subjects in a separate job, including the exact source commit. The negative check rejected a version-tag ref because the authenticated source ref was `refs/heads/main`. Publication was skipped. This validates candidate signing and consumer policy; it does not add a release-tag bundle to rc.3.

The [rc.4 release workflow](https://github.com/sakajunquality/bunko/actions/runs/34286224253) subsequently published real version-tag attestations from `d89fecd854135500e994724573dc58226cae0cdf`. Independent anonymous asset download, exact-candidate equality, all-subject provenance verification and a wrong-ref negative check passed; see [rc.4 validation](validation/rc4.md).
