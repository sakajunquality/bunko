# Release checklist

Use this checklist for each new version, starting with the next patch release. Copy the evidence table into `docs/validation/<version>.md` and replace example versions and commit placeholders before executing commands. This document does not authorize or trigger a release by itself. See [distribution details](RELEASING.md), [npm publishing](NPM_DISTRIBUTION.md), and the [0.1.0 evidence](validation/v0.1.0.md).

## 1. Prepare and merge the release

- [ ] Select a new version; check Git tags, GitHub releases, the GHCR version tag and npm versions. Distinguish an absent version from an authentication, network or service error.
- [ ] Update `package.json`, release notes, compatibility/migration notes and the versioned validation record in a release PR. Keep the repository package `private: true`.
- [ ] Use the release workflow's preparation Bun version (currently 1.3.11). Put that verified executable directory first on PATH and check `bun --version`; invoking an absolute Bun path alone does not ensure nested `bun run` scripts use the same version. Run `bun install --frozen-lockfile --ignore-scripts`, `bun run check`, and `bun run release:prepare /tmp/bunko-<version>-candidate` with a new destination outside the working tree. Record the CLI size, SHA256 and Bun version. Run the applicable application/runtime fixtures on both supported Linux architectures with that exact CLI.
- [ ] Complete local review and the configured external reviews; record unavailable or rate-limited reviews as unavailable, not approvals. Resolve findings and wait for required CI on the final PR head.
- [ ] Merge the release PR and record the resulting **main commit**, which can differ from the reviewed PR head after a squash merge. Confirm CI for the resulting main commit. Keep unrelated work and stashes separate.
- [ ] Prepare a candidate with `gh workflow run release.yml --repo sakajunquality/bunko --ref main`. Confirm the run's `headSha` is the selected main commit and that prepare/verify-candidate pass. This dispatch does not publish a release or create a tag. Manual candidate provenance uses `refs/heads/main`; published release provenance must use the tag ref.

When the `version` input is omitted, the setup Action derives its CLI version from its own tag ref or checked-out `package.json`, so the new tag installs the new release as soon as it is published. An explicit `version` input takes precedence and must be updated separately; no default bump follows the tag. `bun-version` and container digests remain literals and stay on the previously verified values until the new artifacts pass acceptance.

## 2. Check the exact commit, then create the tag

Use a clean main checkout. Run the following as a Bash script (or save it and invoke `bash`). Replace `REPLACE_WITH_REVIEWED_MAIN_COMMIT` with the full 40-character **merged main SHA** recorded above. The guarded block stops before tag creation if checkout, synchronization, version or identity checks fail.

```bash
(
  set -euo pipefail
  release_version=0.1.1
  release_commit=REPLACE_WITH_REVIEWED_MAIN_COMMIT
  [[ "$release_commit" =~ ^[0-9a-f]{40}$ ]]
  test "$(git branch --show-current)" = main
  test -z "$(git status --porcelain)"
  git fetch origin main --tags
  git merge --ff-only origin/main
  test "$(git rev-parse HEAD)" = "$release_commit"
  test "$(git rev-parse origin/main)" = "$release_commit"
  test "$(bun -p 'require("./package.json").version')" = "$release_version"
  if git show-ref --verify --quiet "refs/tags/v$release_version"; then
    echo 'Tag already exists; inspect it instead of replacing it.' >&2
    exit 1
  fi
  git tag -a "v$release_version" "$release_commit" -m "Release v$release_version"
  test "$(git rev-parse "v$release_version^{commit}")" = "$release_commit"
)
```

- [ ] Inspect `git show --no-patch v0.1.1` and confirm the exact recorded commit and version. A failed command must stop the sequence; never append tag/push commands after an unchecked checkout or merge.
- [ ] Push only that tag in a separate step. This is the publication trigger:

```sh
git push origin refs/tags/v0.1.1:refs/tags/v0.1.1
```

- [ ] Record the tag's peeled commit and the Release run ID/attempt. The provenance source digest is that commit, not the annotated tag object ID; confirm it equals the run's `headSha` (as verified for 0.1.0). Do not move or force-push an existing version tag. If the push response is ambiguous, inspect the remote ref and workflow before retrying.

## 3. Verify the GitHub CLI and container

- [ ] Wait for Release prepare, verify-candidate and publish to succeed. Check the published tag, version, prerelease flag and complete asset list. Record the tag workflow candidate hash and compare it with the downloaded release. Investigate any difference from local preparation.
- [ ] Download all five assets into a new directory. Use `PROVENANCE.jsonl` as the signed bundle to verify the four attested payloads (`bunko.js`, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`) against the exact tag ref, tag commit and release workflow **before executing the CLI**, then verify checksums and the installed version. The bundle is the fifth asset, not a payload attested by itself. Use `BUNKO_ATTESTATION_SOURCE_REF=refs/tags/v0.1.1` and `BUNKO_ATTESTATION_SOURCE_DIGEST=<recorded-tag-commit>` with `bun scripts/verify-release.ts <download-directory> v0.1.1`. Confirm that verification rejects an incorrect source ref. Record an independent public download/setup result.
- [ ] Follow the **CLI container** run automatically dispatched by Release's `dispatch-container` job. Do not start a second run manually. Dispatch success only means the run was requested; manual recovery of a failed dispatch requires first confirming no run for the version exists. Record its actual main source SHA, run ID and published index digest; its recipe source can differ from the CLI tag source.
- [ ] Confirm the container run tested both architectures, attested the candidate index and promoted the unchanged index. Independently verify the index attestation against that run's source identity, pull by digest, and execute both architectures with the default nonroot user, read-only filesystem, dropped capabilities and no network. Compare each in-image CLI hash with the GitHub CLI. See [container verification](CLI_CONTAINER.md).

Automatic container publication can finish before independent CLI acceptance. If that acceptance fails, inspect both already-published channels and follow recovery below.

The container workflow has no prepare-only input: dispatching it attempts publication. Do not dispatch it again for an existing version merely to test installation.

## 4. Publish npm and verify registry consumers

- [ ] Confirm the npm Trusted Publisher still targets `sakajunquality/bunko`, `npm.yml`, environment `npm`, with direct publishing permission; the GitHub environment permits main. Use the existing OIDC workflow, not a new local bootstrap publication or long-lived token.
- [ ] Run preparation for the explicit published GitHub release:

```sh
gh workflow run npm.yml --repo sakajunquality/bunko --ref main -f version=v0.1.1 -f publish=false
```

- [ ] Record the run's main SHA. Inspect `npm-candidate`: the seven-file allowlist, exact CLI hash, SHA512 integrity, offline publish dry-run, installation, npm exec, bunx and argument-forwarding results must pass. The workflow must use `npm publish ./candidate/*.tgz`; omitting `./` can make npm interpret the path as GitHub shorthand.
- [ ] Confirm the selected npm version is still unpublished, then dispatch publication:

```sh
gh workflow run npm.yml --repo sakajunquality/bunko --ref main -f version=v0.1.1 -f publish=true
```

- [ ] This creates a new preparation run, not a promotion of the earlier run's artifact. Record its actual source SHA, candidate integrity and publication run ID. If main changed, review those changes before proceeding; compare its candidate with the inspected preparation and investigate any difference.
- [ ] Wait for prepare, publish and verify-published to succeed. Independently download the npm tarball and match its SHA512 to **the successful publishing run's** candidate report. Match the enclosed CLI SHA256 to the verified GitHub release.
- [ ] In a temporary consumer with an empty npm configuration/cache, install the exact registry version and run `npm audit signatures`. Require a verified registry signature and npm attestation. In a fresh Bun cache, run `bunx @sakajunquality/bunko@0.1.1 version` and the intended dist-tag (`latest` for stable, `next` for prereleases).
- [ ] In an isolated npm prefix, install previous → new → previous → new registry versions, executing `bunko version` after each step. Verify a separate Bun install/bunx consumer. Preserve the previous immutable version for rollback.

## 5. Promote defaults and close the release

- [ ] Open a follow-up PR updating workflow version inputs, installation examples and digest-pinned container recipes. The setup Action's CLI default follows its own ref, so `action.yml` and the `scripts/setup.ts` literal need no bump. Keep older version evidence intact; document that Action tags predating ref-derived defaults keep their original defaults and need explicit inputs.
- [ ] Add exact publication and independent consumer evidence below. Distinguish CLI tag source, container recipe source and npm packaging source. Keep unverified provider/application acceptance visible; a version bump does not certify it.
- [ ] Complete review and required CI, then merge. Check main CI and the public installation links. Confirm npm dist-tags and the intended GitHub latest/prerelease status. Announce completion only after the selected distribution channels pass their acceptance checks.

| Evidence | Record for this release |
| --- | --- |
| Version, release PR, merged main SHA, tag/peeled commit | |
| Candidate Bun version, CLI size and SHA256, local checks/fixtures | |
| Release run/attempt and published asset provenance/download results | |
| Container run/source SHA, index digest, attestation and both-platform results | |
| npm run/source SHA, candidate SHA512, published integrity and dist-tags | |
| Registry signature/npm attestation, npm/bunx consumers, upgrade/rollback | |
| Defaults PR, final CI and unresolved acceptance limits | |

## Recovery after an interrupted or failed release

| Failure | Next action |
| --- | --- |
| Checkout/merge/identity guard fails before tagging | Stop. Reconcile the checkout and selected main SHA; rerun the guards. Never continue to tag with an assumed HEAD. |
| Tag points to the wrong commit | Stop publication if it has not started. Record the actual remote tag and any existing assets; review a recovery plan without moving or force-pushing the tag. The ancestry-only repair in 0.1.0 is historical evidence, not a general substitute for correct tagging. |
| Workflow code needs a fix | Merge the fix through review/CI. Rerunning an old run uses its old workflow revision; dispatch a new main run for npm/container fixes. A tag-bound Release workflow needs a separately reviewed recovery plan. |
| Independent CLI acceptance fails after automatic container dispatch | Inspect both channels and stop default promotion/announcement. Diagnose verification versus payload failure; preserve existing versions and publish a new corrected version if the payload is defective. |
| CLI succeeds but container/npm fails | Keep the verified CLI release. Inspect the failed channel and record partial completion; do not repeat all publication steps. |
| Publish response is ambiguous, or post-publication verification fails | Inspect the registry/release and exact bytes first. If the version exists, verify or repair the consumer check; do not republish, unpublish or replace the version. A genuinely defective published artifact requires a new version. |
| npm metadata is temporarily stale | Retry bounded read-only verification; the workflow already allows propagation time. Do not retry publication to fix metadata visibility. |
| Consumers need rollback | Pin the previously verified CLI version/container digest/npm version. Any dist-tag correction is a separate, explicit change after checking its target; immutable version assets stay intact. |
