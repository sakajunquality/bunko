# rc.4 candidate validation

The candidate is prepared with Bun 1.3.11 using the reviewed Bun 1.4 implementation and `package.json` version `0.1.0-rc.4`. CLI size: 7,832,229 bytes. SHA256: `6d48f7dcbc0558800c97d45e1aab78a9d3878467832c6e561925b0cdff2d54c0`. Checksums and CLI version are verified during preparation. Publication and anonymous consumer verification are separate acceptance steps; this record does not claim that a candidate has already been published.

## Implementation coverage

The Bun 1.4 compatibility matrix covers Linux/macOS hosts on Bun 1.3.11, 1.3.12, 1.3.13, 1.4.0 and 1.4.2. Focused tests retain unsupported-version rejection, lockfile integrity/source checks, and rejection of v2 locks with old toolchains before registry access. The untouched Bun 1.4.2 lock fixture records the generated schema. CLI container validation generates a fresh v2 lock, frozen-installs its dependency, compiles and executes the application.

Pinned official runtime archives and notices cover Bun 1.3.11–1.3.13 and 1.4.0–1.4.2. Every Linux archive pin is checked against the release's embedded-key-verified checksum fixture; notice and runtime pin version sets must match. This is additional evidence for specific versions, not a claim about future patch releases.

## Candidate execution

The following checks passed using the exact CLI above. Acceptance commands use a PATH explicitly selecting the tested Bun and copy the prepared CLI to `dist/bunko.js` for fixtures that consume that path. They do not rebuild the CLI implicitly.

```sh
# After preparing the release candidate and selecting the tested Bun in PATH:
cp dist/release/bunko.js dist/bunko.js
BUNKO_CLI=dist/release/bunko.js bun test/compile-smoke.ts
bun scripts/validation/runtime-smoke.ts
BUNKO_SMOKE_INJECT=1 bun scripts/validation/run-fixture.ts
BUNKO_SMOKE_INJECT=1 BUNKO_SMOKE_MODE=source bun scripts/validation/run-fixture.ts
bun scripts/validation/fonts-smoke.ts
bun scripts/validation/telemetry-smoke.ts
```

| Check | Host Bun | Result |
| --- | --- | --- |
| Compile and deterministic recompilation | 1.4.2+744846f84 | Passed on Linux amd64 and arm64 |
| Runtime injection and compatibility boundaries | 1.4.2+744846f84 | Passed on Linux amd64 and arm64 |
| Bundled native application, database and shutdown | 1.4.2+744846f84 | Passed on Linux amd64 and arm64 |
| Source-preserving native application, database and shutdown | 1.4.2+744846f84 | Passed on Linux amd64 and arm64 |
| Fonts: bundle/source, fontconfig/directories | 1.3.11 | All 8 positive and 8 negative checks passed |
| OpenTelemetry Collector 0.120.0 | 1.3.11 | Both traces and metrics passed |

The target platforms are Linux amd64 and arm64. Compile validation compares independent deterministic builds and full authenticated runtime revisions. Runtime injection covers local OCI bases, cache reuse, incompatible static-base rejection and native library boundaries. Application fixtures cover bundled/source runtime discovery, native modules, assets and PostgreSQL. Font checks cover bundle/source mode, Canvas CJK/color emoji, Resvg CJK with fontconfig/explicit directories, and negative discovery controls. Execution uses nonroot, read-only containers; renderer and compiled application checks also disable network access. Collector validation checks both opt-in trace and metric exports.

## Publication and remaining acceptance

The tag workflow verifies signed provenance in a separate job against the exact release ref and source commit, including rejection of the wrong source identity, before uploading immutable assets. The container workflow separately verifies the published CLI's provenance, validates both builders and applications, then publishes and attests its image index. After publication, compare the anonymous download to the candidate hash above and verify the exact tag/commit provenance before execution.

No cloud registry interoperability results from earlier releases are attributed to rc.4. The generic application and font fixtures do not certify external workloads. Private ECR and application-machine acceptance remain separate, explicitly unverified items. See [registry coverage](../REGISTRIES.md) and [remote acceptance](../validation-request.html).
