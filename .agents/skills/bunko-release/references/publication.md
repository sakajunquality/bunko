# Publication procedure

Use current repository commands and workflow names if they have changed. Values such as Bun versions, package allowlists, Action defaults, run IDs and checksums must be discovered for this release; never copy a prior release's identity.

## 1. Signed main candidate

After the release PR merges and its main CI passes, dispatch `release.yml` on main without a publication tag. Verify the run's `headSha` is the selected merged commit. Download `bunko-release` after preparation, then use:

```sh
BUNKO_ATTESTATION_SOURCE_REF=refs/heads/main \
BUNKO_ATTESTATION_SOURCE_DIGEST="$release_commit" \
  bun scripts/verify-release.ts "$main_candidate" "v$release_version"
```

Compare the CLI with the locally tested candidate, and wait for preparation and candidate verification to succeed. Manual dispatch prepares a signed candidate; it is not a substitute for the tag publication workflow.

## 2. Guard the tag

Use the guarded Bash block in the current `docs/RELEASE_CHECKLIST.md`, with a clean checkout on main and the full reviewed merged SHA. Keep its subshell and stop-on-failure behavior. Confirm checkout and origin/main identity, package version, clean tracked state, tag absence, and the tag's peeled commit. Creating the local tag belongs only in an authorized release.

Inspect the result, then push **only that tag in a separate step**. Never move an existing release tag. If main advanced, re-evaluate its diff and candidate identity rather than weakening the guard.

## 3. GitHub and GHCR

Wait for the tag-bound Release workflow. Record its run ID, attempt and peeled tag commit, plus tag CI/security results. Download all release assets into a new directory. The historical five-file set is `bunko.js`, `SHA256SUMS`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `PROVENANCE.jsonl`; check current repository generation.

Run `verify-release.ts` with the **tag ref** and full tag commit, before executing the CLI. Compare local/main/tag workflow candidates and public release bytes. Require wrong-source-ref verification to fail for a source mismatch, not for a missing bundle or network error. Independently install through the repository's public setup function/Action with provenance verification enabled and check the version.

Release automatically dispatches the container workflow. Follow that run; do not dispatch a duplicate. Its dispatch result only confirms a request, not publication. Record the actual recipe source SHA, candidate index digest, both-platform validation, attestation and unchanged-index promotion. The container workflow has no preparation-only mode.

Verify the published OCI index attestation against the exact container workflow, main ref and source SHA, then pull by digest anonymously. Run both amd64 and arm64 as the default nonroot user with read-only filesystem, dropped capabilities, no-new-privileges and no network; check version and in-image CLI SHA256. Local emulation and native CI are distinct evidence.

## 4. npm

Use the existing GitHub Actions OIDC workflow/environment, not a local bootstrap publish or a new long-lived token. Dispatch `npm.yml` on main with explicit version and `publish=false` after GitHub artifact acceptance.

Inspect `npm-candidate`: current file allowlist, exact CLI digest, SHA512 integrity, dry-run publication, installation, npm exec, bunx and argument forwarding. Reconfirm the version is absent with a definitive registry response before dispatching `publish=true` once. The publishing run creates a new candidate; record its actual source and compare its tarball with the inspected preparation. If main changed, review the intervening changes first.

Successful `npm publish` may report that the package is still being processed. Registry 404/ETARGET can persist beyond the workflow's initial wait. Read [recovery.md](recovery.md); publication success is not yet consumer availability.

Once visible, independently download the registry tarball and match its SHA512 to the successful publishing candidate, and its CLI SHA256 to GitHub. In an isolated consumer with empty npm configuration and fresh npm/Bun caches, a temporary child HOME and TMPDIR, verify exact-version installation, registry signature and npm attestation, exact/intended-dist-tag bunx, separate Bun install, and previous -> new -> previous -> new execution. For prereleases use the intended prerelease dist-tag; do not silently move `latest`.

## 5. Evidence and defaults

Use the repository's versioned validation reports as a format reference, not a replacement template with blindly substituted versions. Include:

- Release PR/head, merged source, tag and workflow run/attempt identities.
- Exact CLI size/hash/toolchain and applicable fixture results.
- GitHub provenance/download/setup and wrong-ref rejection.
- Container source/index/attestation and both-platform consumer results.
- npm preparation/publication source, candidate integrity, registry integrity, signature/attestation and upgrade/rollback results.
- Review availability, failures/recovery, native versus emulated checks, and unverified provider/workload limits.

The follow-up updates current README/install instructions, workflow default inputs, release/feature/npm/CI guides and container recipe digests. Preserve old release sections and historical hashes. Version and `BUNKO_ATTESTATION_SOURCE_DIGEST` in an npm preparation example must refer to the same release. Note a deferred independent setup-bunko Action promotion explicitly rather than implying its default changed.

## Consumer helper execution boundaries

`verify_npm_consumers.py` requires `--previous-integrity` as well as the new publishing candidate's `--integrity` and verified GitHub `--cli-sha256`. Both versions must have independently accepted provenance before use. It verifies both registry tarballs and every installed executable before execution. For bunx it resolves the exact version and intended dist-tag read-only, installs the pinned version without lifecycle scripts, verifies its bytes, and invokes the local package with `--no-install`. This separates mutable tag resolution from code execution; it does not claim a direct `bunx package@latest` network-install test.

A failed external command writes private stderr diagnostics under the helper's temporary directory and reports the path. Inspect these locally to distinguish registry absence, authentication and network errors. Do not paste raw logs into reports or PRs: they may contain signed URLs or credentials. Reports deliberately retain only accepted identities and outcomes.
