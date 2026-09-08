# Public repository readiness review

Reviewed on 2026-09-08 (Asia/Tokyo), starting from main commit `87b7fffafa39f5a38afe2fbe5d43fd5055b902e8`. GitHub visibility is still private. This review and its changes do not change repository visibility, cloud IAM, or package visibility.

## Findings

No credentials were detected in the audited source, history, or available GitHub records. The changes accompanying this review add the owner's selected MIT license, complete dependency notices, and CI action pinning. Within this scope, there is no identified credential-related blocker to making the repository public after merging the changes.

Public visibility also exposes non-secret information already present in history: a personal Git author email, the owner/repository names, the dedicated Google Cloud project and Artifact Registry paths, image digests, and validation timestamps. The exact email is intentionally not repeated here. Removing such information from the current tree would not remove it from earlier commits. The owner accepted disclosure of historical commit email addresses on 2026-09-08. Dedicated cloud identifiers remain documented as non-secret validation context.

## Audit scope and evidence

- Gitleaks 8.30.1, downloaded from its official GitHub release and verified against the published SHA-256 checksum, ran locally with full redaction and default rules.
- All 25 reachable commits across local and fetched remote refs were considered. The Git diff scan inspected 16 non-merge commits. A separate scan of all 193 unique reachable blobs also covered the contents of merge commits. Both scans reported zero findings.
- All 40 available Actions run logs and 15 artifacts were downloaded and their archives extracted locally. Nine PR review records, issue/PR bodies, issue comments, and inline review comments brought the remote inventory to 67 successfully fetched resources. The extracted-data scan reported zero findings.
- Separate scans of the proposed source tree and prepared minified release assets also reported zero findings. The release assets passed checksum verification and isolated CLI smoke checks.
- Additional current-tree checks found no private-key/token markers, credential files, or user-specific home-directory paths. Repository Actions secrets and variables were empty; no releases existed at the audit cutoff.
- Raw logs and redacted scanner reports remain outside the repository. The scanner did not upload source or findings to an external service. Detection coverage is limited to the rules and records examined; it is not a guarantee that every possible secret format can be recognized.

Reproduce the source-history check with a current Gitleaks installation:

```sh
gitleaks git . --log-opts=--all --redact=100 --report-format=json \
  --report-path=/tmp/bunko-history-scan.json
```

The inventory above is a dated snapshot. New commits, comments, workflow runs, or artifacts need their own review before publication. [GitHub visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) describes the additional content made public.

## Licensing and distribution

The project uses [MIT](../LICENSE), selected by the owner. `package.json` declares the same license. Its `private:true` field prevents accidental npm publication; it does not control GitHub visibility and can remain true in a public GitHub repository.

The CLI includes YAML's ISC notice, TypeScript's complete Apache-2.0 license, and TypeScript's upstream third-party notices, including Unicode attribution. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) reproduces those texts with line-ending and trailing-whitespace normalization. The MIT license is embedded in the CLI and shipped as LICENSE. Release preparation, checksum verification, installation, and publication all include that asset. Third-party material keeps its own terms.

## GitHub Actions

CI runs on GitHub-hosted Linux/macOS runners with `contents:read`. It uses `pull_request`, not `pull_request_target`, and has no Registry credentials or write grants. Checkout/setup actions are pinned to verified commit IDs; checkout does not persist the token in Git configuration.

Registry publication is an explicit `workflow_dispatch` operation. Release publication requires a matching version tag whose commit is reachable from main; its write token belongs only to the publish job. There is no `workflow_run` path that consumes artifacts from untrusted PR runs.

The repository's default workflow token permissions are read-only, and Actions cannot approve PRs. GitHub rejected the fork-contributor approval-settings read while this repository was private, so that setting could not be verified in advance. Check external-contributor workflow approval and secret-scanning/push-protection settings when making the repository public. No settings were bypassed or changed by this review.

## Alpha.2 distribution follow-up

The updated source, all reachable Git history, unique historical blob contents and prepared distribution were scanned again with Gitleaks 8.30.1; no credentials were detected. A separate byte inspection found that Bun had embedded TypeScript's absolute build-time directory/file globals in candidate bundles. The shared bundler now resolves those globals at runtime, and release regressions reject checkout paths in the CLI. Those earlier candidates are superseded. This distinction matters: a secret scanner alone does not detect every identifying build path. The [current candidate evidence](validation/alpha2-release.json) records exact artifact hashes and runtime results.


## Post-release publication review

The follow-up audit examined main `2ef59db56b2d073b290cb80d9186cfd4fdee3164` on 2026-09-08, including all remote branches and 21 PR head refs. It covered 64 reachable commits and all 552 unique blobs, 104 available Actions logs, 78 retained artifacts, PR bodies/comments/reviews, and all four published release assets. All 207 downloaded log/artifact/review/asset resources were retrieved successfully; the metadata inventories were scanned as well. Gitleaks found no credentials in current source, Git diffs, historical blob contents, or approximately 61.69 MB of fetched remote content. The lockfile advisory check returned no advisories. Seven release checks passed with 55 assertions.

One superseded candidate, artifact `10037454412` from run `34176537109`, contained a generic GitHub runner build path. The owner authorized its deletion, and it was deleted during launch preparation. No history was rewritten. The published alpha.2 CLI retains SHA-256 `fc6af0500637623df354ebe983004447acade1abd4117fd41b25d7b3456241e6`; its checksums and notices matched, and it contained none of the checked build paths. Normal runner paths in historical Actions logs are not personal workstation paths or credentials.

The current preparation changes remove stale private/candidate wording, label restricted test-workflow links, add a security reporting policy, disable credential persistence in the manual conformance checkout, and bound the CI matrix runtime. The separate test repository remains private. Historical audit and validation sections retain their original checkpoints.

At the audit cutoff, default workflow tokens were read-only and could not approve PRs; repository Actions secrets, variables, environments, and self-hosted runners were empty. Wiki, Pages, and Discussions were disabled. The private repository's fork-approval endpoint returned 422; branch/ruleset reads returned 403; security-analysis details were unavailable. These responses do not establish the settings after publication. Verify external-contributor workflow approval, main/tag protection, secret scanning, push protection, and private vulnerability reporting at the actual visibility transition. Publication is a separate owner-authorized step.
