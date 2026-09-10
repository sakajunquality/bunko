# v0.3.2

Workspace builds reuse dependency closure plans after application-only edits, while cycles and closures containing selected targets remain protected against stale cache reuse. Host build dependency installs select the target and root workspace trees. Bundles that reach another member outside the guaranteed install scope are rebuilt after a full install, including when a root dependency would otherwise silently satisfy the wrong version.

Publication places blobs concurrently with `--publish-concurrency` or `BUNKO_PUBLISH_CONCURRENCY` (1–32; default 6, or 3 for Docker Hub). Manifests follow completed blob placement, failures drain started work, and reports retain deterministic transfer ordering. Registry cache exports use the same bound. New requests honor shared Retry-After deadlines, including deadlines extended by later responses.

Reports include publication timing and blob counts; the host dependency install has a `build-deps` timing and OpenTelemetry stage. Bun support remains >=1.3.13 <1.5. Existing configuration remains compatible; conservative full workspace installation can still occur for ambiguous workspace dependency selectors.

See [performance behavior](https://github.com/sakajunquality/bunko/blob/main/docs/PERFORMANCE.md) and [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.3.2.md).
