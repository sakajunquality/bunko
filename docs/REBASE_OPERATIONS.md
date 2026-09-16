# Operating base updates

Use a CLI containing these commands; older releases do not provide them. [The rebase safety contract](REBASE.md) still applies. Base discovery never writes registry data or executes image code.

```sh
bunko base-status ghcr.io/example/app@sha256:IMAGE --base-tag oven/bun:1.4.2-distroless --json
bunko base-status --targets rebase-targets.json --json
```

A targets file has `schemaVersion: 1` and a `targets` array of 1–128 entries with `image`, optional `oldBase`, `base` (the tag to poll), `platforms`, `policy`, `tags` and `smoke`. Tags and smoke are configuration for your orchestration; discovery does not execute them. The file is limited to 64 KiB. Registry tags are resolved once and reported as immutable references. Stored base annotations are digest-pinned and cannot recover the original mutable tag: supply `base`/`--base-tag` explicitly. Local images usually need `oldBase` as well. Derived old-base references must use the configured replacement repository; cross-repository transitions require explicit `oldBase`.

Results distinguish `current`, `outdated`, `not-rebaseable`, and `unknown`. An outdated record includes a dry-run decision. Missing ownership metadata requests a rebuild. Failed inspection is unknown, not current; registry credentials, network failures, or corrupt input must be investigated. Current means the selected platform base digest matches, not that the application has passed a new acceptance test. Identical-content repacks retain the existing native-code allowance; changed bases with native code require rebuilding.

## Decisions and policy review

`rebase --dry-run --report FILE` exits 0 for `compatible`, 3 for `requires-policy`, 4 for `requires-rebuild`, and 1 for operational/input errors. Reports include the same `decision`, a stable `reason` for typed compatibility failures, and a bounded file-change summary for policy requests. Ordinary publication failures remain exit 1. Hard runtime/configuration incompatibilities are checked before suggesting a policy. A policy never overrides runtime revision, libc, native-code or preserved-layer checks.

```sh
bunko rebase-policy --old-base registry.example/base@sha256:OLD \
  --base registry.example/base@sha256:NEW --platform linux/amd64,linux/arm64 \
  --out reviewed-abi-policy.json
```

This writes a new, non-overwriting schema-2 template with `reviewed: false`. It emits distribution IDs, expected loader path, bounded library path lists and changed-file counts to stderr for review. Library paths are not extracted SONAMEs or ABI proof. Select `--runtime-libc musl` when appropriate. Compare vendor ABI guarantees and runtime tests before changing `reviewed` to true through a reviewed PR. Schema-2 policies without explicit approval are rejected. Existing schema-1 policies remain supported as the previously documented explicit ABI contract; new templates use schema 2. The template inspects the two pinned bases directly; `check-base --requirements-report` instead consumes an existing build report.

## Acceptance and tag promotion

```sh
bunko rebase registry.example/app@sha256:IMAGE \
  --old-base registry.example/base@sha256:OLD --base registry.example/base@sha256:NEW \
  --repo registry.example/app --tag stable --tag v1.2.3-rebased-20260916 \
  --tag-conflict skip --sign-key ./cosign.key \
  --smoke-command '["/usr/local/bin/bun","/app/acceptance.js"]' --report rebase.json
```

The acceptance argument is a JSON argv array, not shell text. It runs only inside each candidate platform container, with nonroot UID, read-only root, no network, dropped capabilities, no-new-privileges, and memory/PID limits. Each command must finish successfully within 60 seconds. No default five-second startup heuristic is used: a live process or listening socket is not application acceptance. The configured command replaces the entrypoint and must itself exercise the workload you want to verify. Docker and any required emulation must be available. Output is suppressed to avoid copying application secrets into the report.

With smoke enabled, ordering is digest publication, attachments, per-platform acceptance, signing, then tag promotion. Failed acceptance preserves pending tags in the failure report. Registry publication is not transactional: the digest may already exist, and partial tag promotion is possible. Existing immutable tags skipped by the registry remain recorded as skipped; that is not successful movement of a stable tag. No rollback of tags is automatic. Retain the old digest from the report and use an explicitly authorized registry tag operation to roll back. Without smoke, existing rebase behavior is unchanged.

## CI integration

[The assessment workflow](../examples/ci/rebase.yml) is read-only and grants no publication or issue/dispatch privileges. Set `BUNKO_REBASE_VERSION` to a reviewed release containing these commands, then configure registry read credentials and reviewed targets in your own workflow. Use immutable Action revisions in production. Route `outdated` + `compatible` to a separately authorized rebase job, `requires-policy` to policy review, and `requires-rebuild` to the application's rebuild pipeline. Do not treat unknown records as success. Configure issue deduplication and dispatch targets in your repository rather than letting image metadata choose repositories or workflows.

[The composite Action](../rebase/action.yml) uses an installed CLI, defaults to assessment, exposes decision/digest/report plus promoted, skipped and pending tags. Its `reference` is populated only after acceptance and complete tag promotion; `candidate-reference` also exposes a published but unaccepted digest. It defaults tag conflicts to failure, and requires an explicit acceptance command for publication. Install Bun and the appropriate CLI version first. Serialize jobs that promote the same mutable tag; registries offer no universal compare-and-swap. Prefer mirrors for repeated upstream tag reads and `prepare-base` for local inputs. An unchanged target needs no publication.

The same flow works in Tekton or Cloud Build by running the CLI container: persist the status/report files between steps, branch on exact decisions, and isolate the Docker acceptance step on a runner with a daemon. Do not launch Docker inside a privileged CLI container just to run assessment. Platform teams must supply their own credentials, test commands, issue destination and rebuild workflow; this change does not enable a scheduled publisher in Bunko's repository.
