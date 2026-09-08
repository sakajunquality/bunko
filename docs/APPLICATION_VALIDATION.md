# Application acceptance before stable release

Use v0.1.0-rc.3 with Bun 1.3.11–1.3.13. Keep the source revision, CLI checksum, Bun revision and digest-pinned base constant. A successful `check-config` is a configuration result, not a functional compatibility result.

## Public functional fixture

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run test:application-validation
# Linux CI can select its native architecture:
BUNKO_SMOKE_PLATFORMS=linux/amd64 bun run test:application-validation
```

Docker must be running. The independently authored fixture in `examples/application-validation` uses Hono, PostgreSQL and `@node-rs/xxhash`. The runner builds the distributed CLI's image, verifies named migration/worker commands and persisted database rows, exercises HTTP/static files and exact mapped/local file contents, checks a known native hash, and verifies server SIGTERM exit. Containers use non-root, read-only roots; a disposable database lives on an internal Docker network with a generated password and tmpfs data. HTTP assertions run inside the server container; an independent client container verifies that an in-flight request completes during SIGTERM. No host port is published. Only fixed check names and booleans are printed. Owned containers, images, network and temporary files are removed on completion; an externally killed runner may require manual cleanup of its `bunko-acceptance-*` resources.

The [local candidate result](validation/rc2-candidate.json) records the exact CLI checksum and tested scope. The fixture defaults to amd64 and arm64. Cross-architecture execution requires Docker emulation or a matching native runner. It is a static web fixture and a database task worker, not a React Router/Temporal/Snowflake compatibility test. Service credentials and application source are not used in public CI.

## Prepare a private workload locally

1. Work in a private disposable checkout with the existing frozen lock. Bind its root through `BUNKO_VALIDATION_SOURCE`; never put the source root or organization name into public commands, configuration, reports or issues. Use an explicit server target in mixed workspaces. Target selection retains the workspace installation topology.
2. Review application build scripts locally. Generate the frontend and prebuilt workflow bundle before Bunko, using the application's normal trusted build process. Bunko has no application build hook. Keep generated inputs deterministic and exclude credentials.
3. Add a local-only Bunko configuration with a neutral `imageName`, named entries/default, explicit runtime assets and logical external mappings. Prepare the exact asset source/destination manifest and expected content checks before execution. `process.cwd()` or explicit environment paths can replace location-sensitive bundled source paths. Never infer success from a fallback value.
4. Review each native or location-sensitive dependency for externalization. Allow ignored hooks only after confirming published artifacts are sufficient. Use a Bun-containing, digest-pinned base with the required native ABI/shared libraries. `check-base --run` tests Bun, not every application addon.
5. Review migration orchestration separately. A script that launches another executable is not made self-contained by bundling. Use an explicit TypeScript entry that calls the migration API and ordered sync steps, or run the existing migration tooling as a separate trusted preparation job. If choosing the latter, mark the migration-image criterion unverified; do not report it as an image compatibility pass.
6. Run `check-config` and `doctor` with every selected `--asset-context NAME=DIR` binding. Their JSON can still contain application names and logical paths. Keep it private. Then build with `--push=false --git-metadata=false`, a private output directory, no public registry cache and no automatic artifact upload. Use the build report's entry map to select commands.
7. Use disposable databases and test service accounts. Supply credentials only at runtime, using a private env file or secret mechanism. Verify real reads/writes, native execution, workflow completion, bot behavior in a test destination, file content, graceful shutdown and both target architectures. Do not run migrations or send bot messages against production as an acceptance shortcut.

## Output handling

Create quarantine directories outside the source checkout using `umask 077`. Keep source copies, layouts, Docker archives, caches, raw stdout/stderr, inventory and provenance private. `imageName`, `--git-metadata=false`, sourcemap controls and `inheritBaseOciLabels: false` are not anonymizers. Source strings, package names, generated files and logs can retain identity.

An optional exact-identifier gate is available:

```sh
# Set these locally; do not paste private values into an issue or CI log.
export BUNKO_QUARANTINE
export BUNKO_PRIVATE_TERMS_FILE
bun scripts/validation/scan-output.ts
```

The terms file is a JSON array of printable ASCII strings, each 3–1024 characters. Keep it outside the scanned directory with mode 0600. Include known organization/repository names, source roots, private hosts and aliases. The scanner checks descendant filenames, raw file bytes and outer gzip contents, case-insensitively, including URI/JSON escaping and UTF-16LE variants. It rejects symlinks, special files, recognized uncompressed tar/ZIP/zstd files and reads above a combined raw/decoded 1 GiB budget. Stop build processes and other writers before scanning. The scanner pins file descriptors, compares inode/size/mode/nanosecond timestamps around reads and rechecks observed files/directories before returning; observed changes fail the gate. This is not an atomic filesystem snapshot or protection from a writer acting after a check. Files must remain unchanged through inspection and subsequent use. Errors omit paths and terms.

This is not a general secret scanner or redactor. It does not decode arbitrary nested archives (including compressed tar members), base64, obfuscation, other compression or Unicode identifiers. A quarantine containing a Docker tar archive intentionally fails this gate. You may inspect its OCI layout subdirectory separately, but that gives no verdict on sibling archives or logs. Passing does not approve an image or log for publication. For private workloads, publish neither images nor raw reports/logs through this workflow. Return only a manually reviewed summary with fixed check IDs, pass/fail/not-run results, architecture, public tool versions and a generic failure category. Keep free-form diagnostic detail on the private machine. A failed gate is a stop, not permission to replace a few strings and upload the rest.

## Remote handoff and acceptance

Use [the standalone validation request](validation-request.html) on the application machine. Complete the whole matrix or mark individual checks `not-run` with an anonymous reason. Frontend build, actual Temporal workflow execution, Slack test delivery and Snowflake native behavior are workload checks still required beyond the generic fixture. Source-preserving mode remains future work. Optional signed runtime injection is available; follow the [runtime guide](RUNTIME_INJECTION.md) and verify native library requirements separately.
