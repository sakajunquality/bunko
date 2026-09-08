# Diagnostics review and validation

Historical review snapshot for [PR #14](https://github.com/sakajunquality/bunko/pull/14); test counts and runtime results describe that change, not the current total.

Claude Code 2.1.263 reviewed diagnostics, CLI option routing, compatibility documentation, the SQLite example, CI and previous cache/layout publication additions using read-only tools.

Fixed findings:

- Remote cache conflicts refuse replacement and log a cache warning without failing an already published image. Local conflicting outputs still fail before publication. Cache packing identity now includes Bunko's version.
- A failed local persistence attempt disables further persistence for that invocation, shared across target caches, avoiding repeated stale-lock waits. Locks are still never broken automatically.
- `check-config` rejects `--bun-path`; `doctor` accepts it and an explicit cosign path. Diagnostic lock/config checks do not require npm authentication secrets, while registry URL substitutions must still resolve.
- Prune rejects explicit negative dry-run values and HTTP registry flags for local pruning. Deletion continues to require `--execute`.
- The setup action receives the matrix Bun version instead of resetting the 1.3.12 job to 1.3.11.
- `push-layout` verifies/snapshots every reachable blob before publication and rejects foreign attachment subjects. `--report` captures partial publication; an attachment failure also identifies the already published root in stderr.

One review statement was narrowed: build's outer batch failure handler already preserved publication state when a late cache conflict escaped; the actual remaining issue was treating optional remote cache publication as a fatal image result. This now logs without overwriting a conflicting cache.

Validation: the configuration, ignored-flag and prepublication layout corruption tests pass. The full suite passed 203 tests, followed by focused verification including the added partial-publication regression (204 total tests). Bun 1.3.11 and 1.3.12 both passed SQLite health/write/read checks on Linux amd64 and arm64 in bundle and compile modes (eight combinations), with a read-only root filesystem, non-root user and writable temporary state. Raw digests are in validation/runtime-compatibility.json. Bundled CLI smoke and a locally prepared checksum-verified distribution passed; no public release was made. CI covers both Bun versions on Linux/macOS and runs Docker integrations on Linux.
