# Run Bun-built applications on Node

Set `runtime.kind: "node"` to use Bun's build toolchain and run the resulting image with Node. Bun remains the default. Dependency installation still uses Bun's isolated linker and `bun.lock`; npm/pnpm lockfiles are not consumed. Dependency-free projects need no lockfile.

```json
{
  "bunko": {
    "runtime": { "kind": "node", "node": "24", "args": ["--max-old-space-size=256"] }
  }
}
```

`--runtime-kind node` overrides the configured kind. Workspace `bunko.defaults.runtime` is inherited normally. `runtime.node` selects supported major `22` or `24`; otherwise a compatible `engines.node` range selects 24, then 22, with 24 the default when no engine is declared. Ranges that cannot select a major's `.0.0` baseline need an explicit major and independent base-version verification. This selection does not assert that an arbitrary base satisfies an engine range.

| Output | Node support |
| --- | --- |
| Bundle | Bun targets Node, emits ESM `.mjs`, and bundles npm dependencies unless externalized. TypeScript build inputs are supported. |
| Source | JavaScript `.js`/`.mjs`/`.cjs` only. Module semantics come from the packaged package.json. No Bun `--no-install` flag is added. |
| Compile / SEA | Unsupported; select Bun compile or build a separate artifact. |
| Runtime injection | Unsupported; the base must already contain Node. |

Source mode does not rely on Node type stripping. Prebuild TS/JSX and point bunko at the generated directory; permitted application TS/JSX source files must be excluded. Declaration files do not count as executable source. Statically visible TS imports are rejected. See [the prebuilt example](../examples/prebuilt/README.md) for npm/pnpm build output and [the Node HTTP example](../examples/node-http/README.md) for a complete application.

## Bases and runtime identity

| libc | Default Node 24 base | Executable |
| --- | --- | --- |
| glibc | `gcr.io/distroless/nodejs24-debian13` | `/nodejs/bin/node` |
| musl | `node:24-alpine` | `/usr/local/bin/node` |

Node 22 uses equivalent `nodejs22-debian13` / `node:22-alpine` references. Pin digests for reproducible production builds. Official Node and recognized distroless bases infer their executable path; all custom bases and local layouts require `runtime.nodePath`. Builds verify that the selected file exists and is executable. They do not execute image code on the host or infer a trusted Node version from ELF strings.

```sh
bunko check-base --runtime-kind node --base gcr.io/distroless/nodejs24-debian13 \
  --platform linux/amd64,linux/arm64 --run
```

`--run` uses Docker with a nonroot, read-only container to execute `node --version`. For a custom base add `--runtime-path /absolute/path/to/node`. This validates startup and reports the actual version; it does not validate your application or certify native addon ABI compatibility. Build reports/SBOM/provenance retain the **declared, unverified** Node major. Bun's version/revision fields continue to identify the build toolchain. Node images receive `org.bunko.runtime.kind=node` and `org.bunko.node.version`; the runtime SBOM component is `pkg:generic/node@MAJOR`, not Bun.

## Compatibility boundaries

The static guard rejects global `Bun`, `bun:*` imports and Bun-only `import.meta` APIs in included source and loaded bundle inputs. Comments, strings, type-only references and lexical local bindings are ignored. `check-config --deep` checks sanitized application sources; bundling also checks loaded dependency sources. Source packaging checks installed JavaScript dependencies. This is conservative: even a guarded Bun fallback can be rejected. Dynamic property construction, native behavior and every future API difference cannot be proven statically. Test your final image.

Runtime arguments use a Node allowlist, including heap limits, warning behavior, CA choices and profiling output options. Bun flags, entrypoint replacement, preload/import hooks and symlink-preservation overrides are unsupported. Application argv belongs in `args`. `NODE_ENV=production` remains the image default; bunko does not inject `BUN_RUNTIME_TRANSPILER_CACHE_PATH` for Node. Explicit or inherited environment settings retain their normal precedence.

Bun's installed dependency symlinks are resolved by Node's normal realpath behavior. ELF architecture/libc checks remain in force. N-API compatibility depends on the addon and runtime; Node-module-ABI addons may require different prebuilt binaries. No install scripts or host native compilation are enabled implicitly. Native dependencies still require an explicitly selected suitable base.

Rebase keeps the same strict ownership, loader, shared-library, native-code and ABI-policy checks. For Node, executable bytes must be identical before and after the operation; changing Node requires rebuilding. Bun-specific embedded revision checking is skipped only for validated Node metadata. Runtime kind is optional in existing metadata (absence means Bun), and unsupported kind/origin combinations are rejected. Rebased SBOMs preserve the declared Node component without claiming a new scan or version check.

Node and Bun application/dependency cache identities are separated. Existing Bun environment and metadata policies remain unchanged. As with other code changes, the builder fingerprint changes across versions; this is not a promise of identical image digests across CLI releases.

## Validation

`bun run build && bun run test:node` exercises glibc/musl × bundle/source × amd64/arm64. It loads disposable images into Docker and checks a real HTTP request, explicit asset read and UID 65532 under read-only/no-network constraints. Set `BUNKO_SMOKE_PLATFORMS` to select available emulation. Unit tests additionally check configuration, API rejection, host Node execution, SBOM/provenance and identical-runtime rebasing. These tests do not cover every npm package or native addon.

References: [distroless Node images](https://github.com/GoogleContainerTools/distroless/blob/main/nodejs/README.md), [Node releases](https://github.com/nodejs/node/releases).
