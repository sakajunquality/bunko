# Snyk Code triage

The September 11, 2026 investigation reported four `javascript/reDOS` and
15 `javascript/PT` findings. These counts describe that investigation, not a
fresh scan of the current commit. The original scan's individual finding IDs
and complete data-flow traces are not committed, so the group-level reasoning
below does not establish that every reported finding is a false positive.

## Glob matching

The reported callers are `packages/bunko/cli.ts` and
`scripts/compare-builders.ts`. For a trace ending at the asset selection call
`new Bun.Glob(pattern).match(local)` in `packages/bunko/build.ts`, `local` is a
path matched against a glob, not a regular expression compiled from that path.
Confirm that exact receiver and argument order in each finding before
classifying it. CLI arguments and project configuration are trusted operator
inputs under the model described in [SECURITY.md](../SECURITY.md).

Re-review if the receiver, pattern source, or trust boundary changes. This
reasoning does not establish a general complexity guarantee for glob matching.

## Digest-derived filesystem paths

The reported files are `packages/bunko/cache.ts`,
`packages/oci/artifacts.ts`, and `scripts/promote-container.ts`.
`descriptor()` validates registry digest syntax with `assertDigest()`.
`BlobStore.path()` repeats that validation before deriving a blob filename;
the accepted SHA-256 hexadecimal component cannot contain path separators or
parent-directory segments. Streamed blobs are also verified against their
expected digest and size before use.

Cache metadata paths have separate key and kind validation; they do not all
pass through `BlobStore.path()`. Check the entire source-to-sink trace and the
applicable validation before dismissing a finding. A valid digest alone does
not prove arbitrary archive extraction or other path handling safe.

Re-review when path construction, descriptor/key validation, digest algorithms,
or archive handling changes, and no later than September 11, 2027.

## Recording and verifying individual decisions

The repository `.snyk` file excludes only duplicate local agent checkouts from
Snyk Code scans. It contains no finding-level ignores. Snyk documents `.snyk`
file exclusions separately from Code Consistent Ignores; putting Code rule
names under `ignore` is not a verified way to suppress these findings.

Before creating an ignore through Snyk's supported UI or Consistent Ignores
workflow:

1. Run an authenticated `snyk code test` on the exact reviewed commit and retain
   its CLI version, repository context, individual finding ID and data-flow
   trace in the security review record. Do not commit credentials or raw scan
   output containing sensitive data.
2. Verify the receiver or sanitizer on that trace and check the relevant
   regression tests. Fix genuine vulnerabilities.
3. If the finding is confirmed false positive, record a finding-specific reason,
   reviewer, expiry and reopening condition through the supported mechanism.
   Do not ignore an entire file or rule to silence these counts.
4. Rescan the same commit and confirm only the intended findings were ignored.
   A green Open Source dependency check is not evidence of a Code scan.

No authenticated rescan or server-side ignore was performed for this document.
Source-level reasoning and YAML validation do not verify scanner suppression.

References:

- [Snyk policy file documentation](https://github.com/snyk/user-docs/blob/main/scan-fix-and-prevent/manage-risk/policies/the-.snyk-file.md)
- [Snyk CLI ignore command](https://github.com/snyk/cli/blob/main/help/cli-commands/ignore.md)
