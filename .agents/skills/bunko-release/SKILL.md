---
name: bunko-release
description: Prepare, publish, verify, or resume a bunko CLI release across GitHub Releases, npm, and GHCR. Use for bunko release/version requests and interrupted publications; the independently versioned setup-bunko Marketplace Action is a separate release.
---

# Bunko release

Release the user's selected version from reviewed source, verify actual consumer artifacts, and leave durable evidence. This skill supplies procedure, not permission to publish or merge. Reuse authorization already given in the conversation; a preparation-only request stops before publication.

## Establish the current state

- Locate the checkout by its Git remote, not a hardcoded home directory or an old temporary clone. Read applicable `AGENTS.md` and current `docs/RELEASE_CHECKLIST.md`, `docs/RELEASING.md`, `docs/NPM_DISTRIBUTION.md` and the relevant workflows. Repository instructions and current implementation take precedence over historical values in this skill.
- Inspect local modifications, main, requested PRs, tags, releases, npm versions/dist-tags and GHCR. Preserve unrelated work. Use a separate checkout when needed. Read-only verification must distinguish 404 from authentication, TLS, network and service failures.
- Confirm the requested release scope and version. Do not silently add later PRs or upgrade unrelated dependencies. The root package stays `private: true`; the npm distributable is generated separately.
- Create a local evidence ledger outside the tracked tree. Record version, reviewed PR head, merged main SHA, candidate Bun version/size/SHA256, workflow IDs/attempts/source SHAs, tag peeled commit, npm integrity and GHCR index digest. Never put tokens, signed download URLs, absolute private application paths or raw credential-bearing logs in committed reports.

## Prepare and review

Use the Bun version pinned by the release preparation workflow, with its verified executable directory **first on PATH**, so nested `bun run` commands use it too. Finish version/dependency edits before starting tests. Changing `package.json` during a test run invalidates version assertions and cache-format comparisons between parent and child processes.

Run frozen installation with scripts disabled, the repository's required checks, and `release:prepare` into a new directory outside the checkout. Run applicable runtime fixtures using **that exact CLI** on both supported architectures. Choose fixtures from the change: compile/assets, native dependencies/fonts, source mode, rebase, prebuilt output, and others as relevant. Use actual loaded image references from `docker load`; tarball tags may be digest-derived rather than the requested publication tag.

For a bundled parser upgrade, validate runtime API compatibility as well as typechecking, bundled size, macro/input/location behavior, and a common-corpus timing comparison. Do not compare different corpora or require cross-package-manager byte identity when bundlers embed install paths. Confirm the current TypeScript 7 exclusion and migration issue rather than removing it as routine maintenance.

Keep merge protection intact. Where authorized, include a compatible version bump/release preparation in the dependency PR to avoid redundant CI cycles. Inspect the actual final head; a successful old head or a bot review-skipped status is not a review. Request configured external review when authorized, reassess findings independently, and record rate limits/unavailability without calling them approval.

Merge only after required final-head checks and findings are resolved. Record the resulting main commit: squash merges change identity. When fetching several refs, do not assume `FETCH_HEAD` selects the PR; fetch into an explicit remote-tracking ref and verify its SHA.

## Publish and verify

Read [publication.md](references/publication.md) for the ordered candidate, tag, GitHub, GHCR, npm and promotion procedure. Read [recovery.md](references/recovery.md) when resuming or diagnosing a failure. Avoid rebuilding or republishing channels that already succeeded.

The essential identity chain is:

`reviewed PR -> merged main SHA -> signed main candidate -> immutable tag at that SHA -> signed tag candidate -> published CLI -> unchanged npm/container CLI`

Main-candidate provenance uses `refs/heads/main`; published provenance uses the exact `refs/tags/v…` ref. Verify workflow, source ref and commit before executing downloaded bytes. Tag source, npm packaging source and container recipe source may differ; record and inspect each instead of assuming equality.

After publication, the included helpers can independently verify consumers:

```sh
python3 scripts/verify_npm_consumers.py --help
python3 scripts/verify_container.py --help
```

Run them from this skill directory, or use their absolute paths. They never publish or move tags. They install/pull public artifacts into isolated temporary state and execute the explicitly selected version, so use them only after provenance acceptance. Supply the new CLI hash and both new/previous npm integrity values from independently verified release records, not merely from the artifacts being checked. The npm helper resolves the intended dist-tag read-only, stages its exact version, verifies the installed bytes, and runs bunx with `--no-install`; it does not execute a mutable tag directly. Compare their assumptions with current repository packaging if a helper rejects a changed allowlist or runtime layout.

## Finish

Promote examples, workflow defaults and digest-pinned recipes only after the new channel is accepted. Preserve historical evidence. Update source-commit pins together with versions; stale source pins make provenance examples fail. The root Action derives the CLI version from its ref/package; the dedicated setup-bunko Action has an independent version and explicit CLI default. Promote that separate repository only within scope, or document its existing default accurately.

Complete the follow-up PR's review/CI, merge, and confirm resulting main CI when required by the checklist. A documentation follow-up does not require another CLI release. Report the release URL, available channels, verification result, and any material deferrals. Do not call npm available just because `npm publish` exited zero.
