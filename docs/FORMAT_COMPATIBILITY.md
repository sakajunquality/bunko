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
| Cache metadata | Separate layer/plan/inspection formats | Caches are disposable optimizations, not interchange attestations. A cache miss after an upgrade is valid; destructive cleanup of foreign formats is a separate retention policy. |

## Rules for future changes

Additive optional report/provenance observations may keep their version when existing meanings are unchanged. List additions under **Format changes**, including semantic changes such as redaction. Removal, rename, retyping, changed interpretation or newly mandatory data requires a version bump and an explicit migration decision. Security-bearing ownership capsules and evidence remain closed-world: blindly ignoring unknown fields could accept an ownership or absence claim that the reader cannot validate. Do not replace their validators with permissive key allowlists merely for forward compatibility.

A future security-bearing format revision should carry writer and minimum-reader metadata as part of the newly versioned schema; adding those keys to today's closed-world v1 would itself break readers. Unknown formats must fail with a version-oriented diagnostic; they must not silently become empty inventories or compatible base decisions. Preserve old valid readers until a documented support window ends. Before 1.0, define that window using fixtures from real released writers; no untested promise of reading all future 1.x data is made here.

Report destinations are protected from accidental overwrite. Known Bunko report shapes, including base-status, may be replaced. Unknown future schema versions are refused; use a new path after rollback instead of weakening the ownership check. Consumers must treat unknown optional report fields as uninterpreted, but reject unknown schema versions.

CLI/config changes should be additive where practical. Renames need an alias and documented warning window; removals/default changes need a **Breaking changes** entry. A universal `since` registry and live previous-release cache/rebase fixture suite remain follow-up work, not features claimed by this policy. Bun support is an explicit tested set/range, not an automatic promise about two newest minors. `@types/bun` has its own package version and is not the supported executable matrix.

## Release acceptance

Record format changes, reader requirements, rollback behavior and cache invalidation in the release section. In addition to current-schema validation, exercise images/SBOMs/reports produced by the previous supported releases. For the next breaking cache change, test mixed-version readers/writers/prune against the same local and registry stores before enabling cross-version reuse. Historical base-inspect v1/v3 namespaces remain historical cache formats; a directory's namespace is not a global manifest of every record version.
