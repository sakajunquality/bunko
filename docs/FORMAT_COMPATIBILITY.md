# Persisted format compatibility

Bunko is pre-1.0. Upgrading the CLI does not retroactively change immutable published images, attestations or reports. Format changes and intentionally changed defaults must be listed in release notes, including the oldest reader known to accept the new form. Do not infer wire compatibility from a CLI version alone.

| Format | Current reader/writer contract | Upgrade and rollback |
| --- | --- | --- |
| Rebase ownership capsule | `version: 1`; strictly validated fields affecting ownership/security | Bun runtime images retain the older shape. Node runtime `kind` was added in 0.9.0 and is not understood by 0.8.x readers. Rebuild/use a newer reader; do not strip fields to bypass rejection. |
| SPDX build evidence | v1 normally, v2 for size degradation since 0.11.0 | Released 0.9.0/0.10.0 readers reject v2 during `rebase --sbom`. Use a reader from 0.11.0 onward; omitted evidence is unknown, not absence. |
| Build reports | schema 2 single-target, schema 3 target collection | Optional fields may be added; consumers check the schema and only depend on documented fields. |
| Resolve/apply reports | schema 4 / 5 | Command identity is part of the format. |
| Rebase/base-status reports | schema 1 plus command identity | Rebase `decision` and acceptance fields require a CLI from 0.9.0 onward. Actions require 0.10.0 onward and check the report shape. |
| Provenance | SLSA predicate plus versioned Bunko buildType | Optional observations may grow; a changed meaning, required field or trust claim needs a new buildType. Consumers must not infer complete capture from optional fields. |
| Cache metadata | Separate layer/plan/inspection formats; optional root layout envelope with numeric reader protocol | Caches are disposable optimizations, not interchange attestations. A cache miss after an upgrade is valid; destructive cleanup of foreign formats is a separate retention policy. |

## Rules for future changes

Additive optional report/provenance observations may keep their version when existing meanings are unchanged. List additions under **Format changes**, including semantic changes such as redaction. Removal, rename, retyping, changed interpretation or newly mandatory data requires a version bump and an explicit migration decision. Security-bearing ownership capsules and evidence remain closed-world: blindly ignoring unknown fields could accept an ownership or absence claim that the reader cannot validate. Do not replace their validators with permissive key allowlists merely for forward compatibility.

A future security-bearing format revision should carry writer and minimum-reader metadata as part of the newly versioned schema; adding those keys to today's closed-world v1 would itself break readers. Unknown formats must fail with a version-oriented diagnostic; they must not silently become empty inventories or compatible base decisions. Preserve old valid readers until a documented support window ends. Before 1.0, define that window using fixtures from real released writers; no untested promise of reading all future 1.x data is made here.

Report destinations are protected from accidental overwrite. Known Bunko report shapes, including base-status, may be replaced. Unknown future schema versions are refused; use a new path after rollback instead of weakening the ownership check. Consumers must treat unknown optional report fields as uninterpreted, but reject unknown schema versions.

CLI/config changes should be additive where practical. Renames need an alias and documented warning window; removals/default changes need a **Breaking changes** entry. A universal per-key `since` registry remains a future extension; no existing key is renamed by this change. Previous-release cache/report/static rebase acceptance is described below. Bun support is an explicit tested set/range, not an automatic promise about two newest minors. `@types/bun` has its own package version and is not the supported executable matrix.

## Release acceptance

Record format changes, reader requirements, rollback behavior and cache invalidation in the release section. In addition to current-schema validation, exercise images/SBOMs/reports produced by the previous supported releases. For the next breaking cache change, test mixed-version readers/writers/prune against the same local and registry stores before enabling cross-version reuse. Historical base-inspect v1/v3 namespaces remain historical cache formats; a directory's namespace is not a global manifest of every record version.

## Released-reader evidence and future-version diagnostics

The checked-in [compatibility fixtures](../test/fixtures/compat/README.md) preserve
ownership metadata from each released minor since 0.8 and evidence from each minor
since 0.9. Their generator verifies immutable writer source identities and checks
an evidence reader/writer rollback matrix. This is serialization evidence on
synthetic inputs, not a claim of complete historical CLI or container acceptance.

Unsupported numeric ownership/evidence revisions raise `UnsupportedFormatError`
with code `BUNKO_UNSUPPORTED_FORMAT`, the format, observed version, supported
versions, and whether the version is newer than this reader. Malformed known
formats still fail strict validation. `base-status` identifies an unsupported
capsule as `not-rebaseable` with reason `unsupported-format`, even when the base
digest is current; this requires a compatible reader, not necessarily an image
rebuild. Authentication and transport failures retain their separate diagnostics.

The format catalog records evidence v1's minimum reader as 0.9.0 and v2's as
0.11.0. Rebase capsule v1 starts at 0.8.0, but the Node variant requires 0.9.0.
These are feature-sensitive requirements, not a reason to add fields to an
existing closed-world capsule. Writer/minimum-reader fields belong in the next
explicit format revision; adding them to v1 would break readers unnecessarily.

### Source CLI upgrade and rollback acceptance

Run `bun scripts/validation/cache-upgrade.ts 0.10.0` and `bun scripts/validation/cache-upgrade.ts 0.11.0` with the pinned commits available in local Git history. The script extracts immutable released source and its lockfile, verifies that the installed dependency declarations match, and executes that historical source CLI. This is not an npm installation smoke test. If dependencies change, install the historical exact lock before extending the fixture; do not silently substitute incompatible parser/compiler versions.

Each run covers a shared local cache, a loopback Distribution registry with fresh local caches, reuse of the same report path across upgrade/rollback, and current `base-status` / `rebase --dry-run` readers consuming the historical image. Warm asset hits and deterministic image digests are checked before and after rollback; the local flow includes current prune with an unlimited retention budget. Rebase uses static synthetic ELF fixtures and does not execute containers. Cloud credentials, real-registry retention policies and runtime smoke tests remain separate acceptance paths.
