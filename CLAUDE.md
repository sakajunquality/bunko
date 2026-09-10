# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What bunko is

bunko builds OCI images from Bun projects without a Dockerfile or Docker daemon, in the spirit of Go's `ko`. It is a single Bun/TypeScript CLI (`packages/bunko/cli.ts`) that is bundled by `scripts/bundle.ts` into a dependency-free `dist/bunko.js`. The distributed CLI needs no external npm packages; its dependencies (including `yaml`, `typescript`, and `ignore`) are bundled at build time, with notices in `THIRD_PARTY_NOTICES.md`.

Write all documentation and code comments in English (see `AGENTS.md`). Non-English text is allowed only in test fixtures that exercise Unicode behavior.

## Commands

```sh
bun install --frozen-lockfile --ignore-scripts   # always frozen, never run install scripts
bun run check          # typecheck + unit tests (what CI runs first)
bun run typecheck      # tsc --noEmit (strict, noUncheckedIndexedAccess, verbatimModuleSyntax)
bun run test           # bun test --timeout 15000
bun test test/tar.test.ts                        # one file
bun test test/tar.test.ts -t "pattern"           # one test by name
bun run build          # bundle CLI to dist/bunko.js
bun run dev build examples/hello --push=false --oci-layout .bunko-output/hello   # run CLI from source
bun run release:prepare  # dist/release with SHA256SUMS; refuses an existing directory
```

Unit tests (`test/*.test.ts`) do not require Docker or external service credentials, but use loopback HTTP/TLS servers and local package-registry fixtures. Python 3, OpenSSL and tar must be on PATH; several tests use `python3`'s `tarfile` module as an independent tar reader (`inspectTar` in `test/helpers.ts`). Signed-runtime verification cases require `gpgv` and are skipped if it is unavailable. Tests spawn the CLI from source with `--no-local-cache` via the `cli()` helper, and use `MockRegistry` (`test/mock-registry.ts`) as an in-memory Distribution endpoint.

Many smoke tests (`test/*-smoke.ts`, run via `bun run test:<name>`) need Docker and network access for prerequisites. Check each runner for its requirements and cleanup scope. The native CA smoke also requires Go; signed runtime injection requires `gpgv`. Set `BUNKO_SMOKE_PLATFORMS=linux/amd64` to restrict platform selection, which is what CI does. `scripts/validation/*` are the application-validation, fonts, runtime-injection and telemetry smoke runners.

CI matrix: Linux and macOS × Bun 1.3.13, 1.4.0, 1.4.2. The supported range is `>=1.3.13 <1.5` (`package.json` engines).

## Architecture

Two source packages, no workspace tooling; they are plain directories with relative `.ts` imports:

- `packages/oci/` — registry-agnostic OCI primitives: `BlobStore` (content-addressed temp store with digest verification), `tar.ts` (deterministic layer packing: normalized ownership, modes, ordering, epoch timestamps), `registry.ts`/`publish.ts` (Distribution API client, ordered blob → manifest → index → tag publication with upload reconciliation), `source.ts` (`RegistrySource`/`LayoutSource` base readers), `layout.ts`/`archive.ts` (OCI layout and Docker archive export/load), `credentials.ts` (Docker config and credential helpers), `tls.ts`/`mirrors.ts`.
- `packages/bunko/` — the product. `cli.ts` parses args with `node:util` `parseArgs` and dispatches to one module per subcommand (`build.ts`, `resolve.ts`, `apply.ts`, `push-layout.ts`, `prune.ts`, `metadata.ts`, `check-base.ts`, `diagnostics.ts` for check-config/doctor, `closure-report.ts` for why/closure-info).

### Build pipeline (`packages/bunko/build.ts`)

`buildTargets` → `prepareTargets` → per-target `prepareBuild`, then publication/export. The stages, and the modules that own them:

1. **Discovery and config** — `workspace.ts` finds a standalone project or workspace root and selects members; `config.ts` validates `package.json.bunko` (unknown keys fail explicitly) and exposes `VERSION` from `package.json`.
2. **Source snapshot** — `files.ts` copies a contained snapshot into a temp dir, applies `.bunkoignore` (`ignore.ts`) and source-mode `.gitignore` (`source-policy.ts`), and rejects unsafe paths and symlinks. Explicit source assets override only `.gitignore`; other exclusions remain authoritative. The whole-snapshot digest is the audit identity.
3. **Dependencies** — `deps.ts` performs frozen installs in temp dirs with install scripts disabled and a constrained env (never uses the checkout's `node_modules`); `closure.ts` projects the Linux package-instance graph for `--deps-strategy closure` / `--shared-deps`; `external-deps.ts` imports prepared dependency OCI artifacts.
4. **Application output** — `toolchain.ts` selects the Bun executable and handles bundle/compile output; `source-application.ts` prepares source-mode output. Bundling runs inside a *trusted worker*: `bundle-worker.ts` is itself bundled by `worker-code.ts` and, for distributed CLIs, embedded as the `BUNKO_WORKER_CODE` define by `scripts/bundle.ts`. Bundler load hooks use `syntax.ts` to reject macro syntax before Bun executes it; related scans in `undeclared-imports.ts` and `location-diagnostics.ts` diagnose runtime imports and module-location assumptions.
5. **Layers and image** — order is `base → optional injected runtime → deps → assets → app`. `image-assets.ts`, `asset-contexts.ts`, `url-assets.ts`, `font-assets.ts` build the assets layer; `runtime-layer.ts`/`runtime-download.ts` handle opt-in signed Bun runtime injection (requires `gpgv`); `oci/image.ts` composes config and manifest/index.
6. **Caching** — `cache.ts` (`LayerCache`) keys on toolchain, compressor, packing version, platform, output config and base/deps identities; entries are materialized and validated before acceptance, with cooperating-process locks (`cache-lock.ts`). Ordered registry/local imports and explicit export destinations are independent (`cache-backends.ts`). Cache read failures fall back; cache export failures warn by default or fail under `--cache-export-error=fail`. Image publication failures are errors.
7. **Publication** — not transactional across targets or tags. Failures after earlier successful writes are recorded in the `--report` JSON; there is no automatic rollback. `attest.ts`/`cosign.ts`/`metadata.ts` add opt-in SPDX, provenance and signing.

`resolve.ts` replaces `bunko://<dir>` scalars in YAML/JSON while preserving formatting; every canonical target builds once and all images are validated before publication starts. Only complete success writes to stdout; all logs go to stderr.

### Invariants that shape changes

- Build commands reserve stdout for result references; resolve/apply use documents, while diagnostic commands have their own structured output. Progress and logs go to stderr. `check-config`/`doctor` switch between text and single-line JSON based on whether stdout is a TTY.
- Determinism matters: layer packing normalizes metadata, `--verify-deterministic` builds twice and compares, and anything that enters a cache key or image label (toolchain fingerprint, packing version, defines) changes identity.
- Trust boundary: bunko builds trusted inputs on the host and is not a sandbox. Install scripts never run, macros are rejected before execution, paths are validated before extraction. See `SECURITY.md` and `docs/DESIGN.md`.
- `docs/SPEC.md` is the normative CLI/configuration contract. When behavior changes, update SPEC.md and the relevant `docs/*.md`; README, `docs/RELEASING.md`, `docs/CI.md` and the workflows pin the current release version in several places.

## Distribution surfaces

- `action.yml` (root) is the **setup** Action; `build/action.yml` + `build/run.ts` is the **build** Action that maps inputs to CLI flags without shell interpolation.
- `container/Dockerfile` packages `dist/release` into a CLI image; its Bun base pin and `container/debian.sources` snapshot must be advanced together.
- `scripts/npm-package.ts` produces the `@sakajunquality/bunko` npm package. Release flow and guards are in `docs/RELEASING.md` and `docs/RELEASE_CHECKLIST.md`; the release tag must equal `v` + `package.json` version.

## Code style observations

The codebase favors dense, single-expression TypeScript with inline validation throws and short `/** */` comments explaining *why* a constraint exists. Follow that: prefer explicit errors for unsupported input over silent fallbacks. A new CLI flag must be added to the per-command allowlist in `command-options.ts` (otherwise the CLI rejects it as unsupported), parsed in `cli.ts`, and if it maps to `package.json.bunko` config, validated in `config.ts`.
