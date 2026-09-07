# Public repository readiness review

Reviewed on 2026-09-08 (Asia/Tokyo), starting from main commit `87b7fffafa39f5a38afe2fbe5d43fd5055b902e8`. GitHub visibility is still private. This review and its changes do not change repository visibility, cloud IAM, or package visibility.

## Findings

No credentials were detected in the audited source, history, or available GitHub records. The changes accompanying this review add the owner's selected MIT license, complete dependency notices, and CI action pinning. Within this scope, there is no identified credential-related blocker to making the repository public after merging the changes.

Public visibility also exposes non-secret information already present in history: a personal Git author email, the owner/repository names, the dedicated Google Cloud project and Artifact Registry paths, image digests, and validation timestamps. The exact email is intentionally not repeated here. Removing such information from the current tree would not remove it from earlier commits. The owner should accept that disclosure before changing visibility.

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
