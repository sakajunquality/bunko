# Application compatibility

Workspace catalogs, named entries, asset mappings and native-addon pruning were introduced in v0.1.0-rc.1. Module-location diagnostics and signed runtime injection are included in v0.1.0-rc.2. Earlier release assets remain immutable.

## Workspaces and catalogs

Use an explicit target for mixed workspaces containing servers, mobile clients, and tooling. A native mobile client is not a Bun server image target. Workspace declarations accept an array or an object with `packages`, `catalog`, and `catalogs`. Catalogs may alternatively live at the manifest root. Do not declare the same catalog field in both locations.

Default `catalog:` and named `catalog:stable` references must resolve to registry dependency specifications. Catalog definitions, manifest declarations, and the frozen lock must agree. Installation retains the complete workspace manifest/lock topology, so catalog changes can invalidate dependency caches across targets. Target selection does not prune installation or relax workspace identity checks.

## Build input validation

The selected Bun executable runs an embedded, trusted build worker. Its `onLoad` hook validates executable bytes before returning them to the bundler. The worker never loads application-provided plugins. Worker, compile, and install subprocesses use empty, dedicated HOME and XDG configuration directories plus explicit controlled bunfig files. Real macros and unsupported or ambiguous attributes fail before macro execution. The checks apply to transitive dependencies and explicitly imported declaration-suffixed files too.

Copied assets and unreachable modules do not receive executable syntax checks. Importing a copied JS asset makes it an executable input again. Data imports with static `type: "json"`, `"text"`, `"file"`, or `"toml"` attributes are supported for explicit relative file paths, and emitted files remain part of the application layer. All loaded file inputs must remain inside the staged context. Mixing different loaders or ordinary imports with a data attribute for the same file is rejected; Bun's plugin API does not distinguish these requests reliably.

Compiler configuration checks follow loaded application inputs. Bun may consult a configuration during resolution before the hook validates it; an unsupported loaded application configuration must prevent artifact creation. An unrelated mobile package's package-based `extends` does not by itself block the selected server. Loaded application configurations still require relative extends inside the snapshot. Snapshot preflight remains conservative about inherited configuration files and exclusions; target selection is not a blanket exemption for malformed configurations or unsafe paths.

The worker carries its own parser to run under the selected Bun version, including in a standalone distributed CLI. This trades distribution size for isolated execution; it avoids scanning every installed module before a build. Validation reports count loaded executable files and bytes. Cross-worker syntax reuse is not currently reported.

## Module-relative runtime files

Bundling does not preserve each source module's runtime location. In particular, an imported module that computes `resolve(import.meta.dir, "..")` can look above the image workdir after it is inlined into an entry or shared chunk. Assets remain at their configured destinations. A successful build or check-config result does not prove those runtime reads succeed.

Use an explicit application root for filesystem assets, for example `process.env.APP_ROOT || resolve(import.meta.dir, "..")` with `bunko.env.APP_ROOT` set to `/app` (or your configured workdir). `process.cwd()` is another option when the deployment preserves the intended working directory. `assetMappings` can provide a stable absolute destination. Existing `build.define` supports explicit constants, but globally replacing module metadata cannot reconstruct every original source directory.

Builds report advisory `BUNKO_MODULE_LOCATION` diagnostics for loaded references to `import.meta.dir`, `dirname`, `path`, `filename`, `url`, and unshadowed `__dirname`/`__filename`. Entries and bundled dependencies are included because code splitting can relocate shared expressions too. A reference may be harmless, removed by tree shaking, or intentionally guarded; this warning does not prove a missing file. Externalized packages and unloaded files are not scanned by this analysis. Indirect uses, dynamic property names and other location APIs are outside its scope.

Each image report includes `locations.total` and up to 100 deterministic `locations.warnings`, deduplicated by source file and expression. Warnings include context-relative paths and positions, not source excerpts or absolute host paths. Application-cache hits replay the same diagnostics. The diagnostic scan does not execute code or modify paths. `check-config` and `doctor` continue to mark source analysis and module-relative file behavior as unchecked. Test exact file contents inside the final image.

When a flagged file lives inside a dependency package, the build derives the package name from the final `node_modules/<name>` segment (Bun's isolated layout nests packages under `node_modules/.bun/<name>@<version>/node_modules/<name>`) and appends one hint after the warning list, for example `Add "@google-cloud/spanner" to bunko.external so it stays in node_modules with its module-relative files (@grpc/grpc-js, google-gax reached through @google-cloud/spanner)`. Only dependencies declared by the selected target are suggested; packages reached transitively are attributed to the declared dependency that loads them using the bundle's import graph, and flagged packages without a declared dependency path are listed separately. The report carries the same data as `locations.packages` (`name`, `declared`, `via`), and `--progress=json` emits the hint as a `log` event, so CI can act on it without parsing prose. Externalized packages are not scanned, so externalizing a dependency clears its warnings; application files never produce a hint.

`bunko.build.moduleLocations: "error"` or `--module-locations=error` fails the build after listing the warnings and the hint. The default remains `"warn"`.

## bunfig.toml

Supported settings:

```toml
[install]
minimumReleaseAge = 86400
minimumReleaseAgeExcludes = ["@types/*"]

[test]
# Test settings are ignored by image builds. No test preload is executed.
```

Only the two listed install settings are forwarded to the controlled frozen installer and included in dependency cache identity. Workspace install settings belong at the root. Bun's age gate affects new resolution; Bunko does not re-audit the publication age of already locked versions. Other install settings, registry/authentication entries, runtime preloads, and unknown top-level settings are rejected. Continue using the supported root `.npmrc` credential mechanism. Diagnostics identify unsupported keys without printing their values.

## Explicit dependency allowances

```json
{
  "bunko": {
    "external": ["ready-made-addon"],
    "deps": {
      "allowIgnoredScripts": ["protobufjs", "ready-made-addon"],
      "undeclaredImports": "warn"
    },
    "build": {
      "allowUnresolved": [""]
    },
    "inheritBaseOciLabels": false
  }
}
```

`deps.allowIgnoredScripts` accepts exact resolved package names whose published files work without their declared install hooks. Hooks are always disabled. The most common trigger is `protobufjs`, pulled in by `@google-cloud/*` and `@grpc/proto-loader`: its published files work without its `postinstall` hook. A build fails until the package is allowed:

```text
Runtime package protobufjs@7.5.5 declares install scripts (postinstall). Bunko never runs install hooks. If the published files work without them, allow the package explicitly in the target's package.json:
  "bunko": { "deps": { "allowIgnoredScripts": ["protobufjs"] } }
Otherwise use prepared dependency artifacts (docs/OPERATIONS.md) or an external base that provides the package.
```

`check-config` and `doctor` list allowances that match no package in `bun.lock` under `unmatchedAllowances`; a non-empty list usually means a typo or a stale allowance, and it never fails the check. An allowance does not generate missing files, repair a native addon, or install a shared library. Prefer externalization for native and location-sensitive packages, and exercise their real behavior in a Linux runtime test. The resolved name/version and ignored hook names appear in inventory; policy and lock inputs affect dependency cache identity. Production, workspace, and closure packaging enforce the policy. Shared dependency layers require matching allowances across targets. Prepared dependency artifacts retain their separate validation contract.

With the closure strategy each package instance has aliases for its declared dependencies and can fall back to application-level aliases. A package that `require()`s a name it does not declare, which hoisted installs mask everywhere else, can build cleanly and fail at runtime with `Cannot find module`. Closure builds therefore scan the packaged `.js`/`.cjs`/`.mjs` files that each package's entry points (`main`, `module`, every `exports` target, `bin`, a string `browser`) reach through relative imports for bare imports that are neither builtins, `#` subpath imports, the package itself, nor declared dependencies, optional dependencies or peers, and log one `BUNKO_UNDECLARED_IMPORT` line per package and missing name:

```text
BUNKO_UNDECLARED_IMPORT grpc-gcp@1.0.1 imports "protobufjs" without declaring it (build/src/generated/grpc_gcp.js); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application's dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.
```

Upgrade the package when a fixed release exists. Otherwise add the missing name to the application's `dependencies` and `bunko.external`: the application alias under `workdir/node_modules` is reachable from every closure instance.

Names a package guards itself are separated from these findings. A missing name is optional when every literal naming it, in every file the scan reaches, is the argument of `require.resolve()`, or of `require()`/`import()` inside a `try` block that a `catch` handler protects; a static source, a `try` block with only a `finally`, an unprotected `catch` body, a plain mention, an unguarded occurrence in any other file of the package, and anything the scan cannot lex with certainty — including a reached file above the 4 MiB cap — all keep the name a regular finding. `debug@4.4.3` is the canonical example: `src/node.js` runs `try { const supportsColor = require("supports-color"); … } catch (error) {}` to pick a color depth and mentions the name nowhere else, so the probe degrades instead of crashing and `deps.undeclaredImports: "error"` can be a CI default without it. The rule is per package instance and deliberately unforgiving, so a package can miss it: `@babel/core@7.27.7` guards `require("@babel/preset-typescript")` inside `getTSPreset`, but the same `lib/config/files/module-types.js` also requires `@babel/preset-typescript/package.json` from a `catch` handler, which is not a guarded position, and the name stays a regular finding. Genuine findings such as `@google-cloud/opentelemetry-resource-util@2.4.0` requiring `@opentelemetry/api` at the top of `build/src/detector/gce.js` are reported as before. `"strict"` additionally logs and fails on the optional ones:

```text
BUNKO_OPTIONAL_IMPORT debug@4.4.3 imports "supports-color" only inside try/catch (src/node.js); treated as optional
```

`"off"` skips the scan. The classification is textual rather than an execution model: a `require()` in a function that only a `try` block calls is reported, and one a `try` block merely defers to a callback is treated as optional even though the deferred call is unprotected, so optional means no unguarded use was found rather than a guarantee that the package cannot crash. Computed specifiers, unparseable files, files above 4 MiB and files no entry point reaches (shipped tests, benchmarks and unused sources) are not inspected, so a clean scan is not proof that every runtime import resolves: an import that exists only in a file skipped for size is never discovered, although reaching such a file does stop the package's other names from being called optional. A package with no resolvable entry point at all is scanned whole, except `test`, `tests`, `__tests__`, `spec`, `bench`, `benchmark`, `browser-test` and `system-test` directories and `test`, `*.test`, `*.spec` and `*.bench` files.

`build.allowUnresolved` uses Bun's **specifier patterns**, not importing-package names. An empty string allows opaque dependency expressions such as `require(variable)` to remain for runtime resolution. Application computed imports remain rejected, and missing literal imports still fail. An allowance does not ensure that a dynamically requested package is present. Leave the setting absent to retain strict behavior.

Packages that ship one prebuilt `.node` per platform in a single tree, such as Temporal's core bridge or Snowflake's minicore, are supported: only the target's little-endian ELF64 shared-object addons with System V/GNU OSABI are packaged. Recognized foreign signatures/architectures and links to those addons are omitted. Unknown content, truncated ELF headers and target non-shared objects remain errors. The nearest named package manifest owns each addon; unnamed module-scope manifests do not split ownership, and lookup stays inside the frozen runtime tree. A package whose addons include none for the target still fails; the runtime selection logic inside the package is not inspected. Fresh runtime walks log omission counts, prepared packing reports omitted paths, and cache hits reuse already filtered layers without recounting. Directory-enumerating loaders see the pruned tree; libc and actual addon loading still require runtime validation.

`inheritBaseOciLabels: false` omits inherited `org.opencontainers.image.*` labels. Explicit application labels and Bunko-generated labels remain; other base labels retain their existing behavior. This option alone does not anonymize image metadata, provenance, inventories, or sourcemaps.

## Trimming a dependency closure

A closure keeps every concrete instance the declared externals reach, so a single well-behaved external can quietly carry a large transitive tree, including the same package under two versions. Nothing about that is visible in an image digest, so start from measurement rather than intuition. The abridged report below shows the shape of the problem for a Bun service depending on `@google-cloud/spanner`, whose closure was 204 packages and roughly 150 MiB of packaged files:

```console
$ bunko closure-info . --top 5
api (.) — linux/amd64, deps.strategy closure
204 packages, 150.3 MiB, 21874 files; 2 duplicated package(s)

Largest packages (5 of 204)
    SIZE  FILES  PACKAGE                              VERSION  VIA
 12.0 MiB   1420  @opentelemetry/semantic-conventions   1.40.0  @google-cloud/spanner > @google-cloud/opentelemetry-cloud-trace-exporter
  7.0 MiB    880  @opentelemetry/semantic-conventions   1.28.0  @google-cloud/spanner > google-gax
  5.0 MiB   1310  caniuse-lite                          1.0.x   @google-cloud/spanner > @babel/core > browserslist
...

Duplicate versions (largest first)
   SIZE  PACKAGE                              VERSIONS
19.0 MiB  @opentelemetry/semantic-conventions  1.40.0 (12.0 MiB), 1.28.0 (7.0 MiB)
```

`bunko why PACKAGE` answers the follow-up question for one name, listing every instance with its version, size, install path and the dependency path from a declared external. `--json` emits the same records (`packages[]` and `duplicates[]`) for scripts, and a closure build writes them into the report under `images[].closure`. A size is the payload of the regular files that instance contributes, before compression; tar headers, padding, directories, symlinks and addons omitted for another platform are not counted, so it sits just under the instance's share of the extracted layer. The registry transfers the compressed layer, which is much smaller and deduplicates repeated trees well, but the extracted image, the page cache and the container filesystem still pay close to the full number.

Three levers, in order of preference:

- **Update the dependency that lags.** Two versions of one package usually mean one dependency pins an older range. `bun update <package>` or a newer major of the direct dependency collapses them without changing resolution semantics for anyone else.
- **Add a `package.json` override.** `"overrides": { "@opentelemetry/semantic-conventions": "1.40.0" }` at the workspace root forces one version for the whole graph. This is a resolution change, not a packaging trick: run the application's tests against the installed tree, because the deduplicated version must actually satisfy every consumer. Bunko validates that `overrides` agree between `package.json` and `bun.lock`, so run `bun install` after editing.
- **Narrow `bunko.external`.** Only packages that must stay unbundled — native addons, packages reading their own files at runtime — need to be external. Every other dependency is better bundled into the application layer, where the bundler keeps only reached code. A build-time-only package such as `@babel/core` or `browserslist` reaching a server image is almost always a dependency of an external that does not need to be external at all.

Removing an instance from the closure is only safe when nothing loads it at runtime; the closure never guesses. Re-run `closure-info` after each change and verify the application in the image, not only in tests.

## Validation and remaining work

Generic fixtures cover catalog frozen installs, pre-execution macro rejection, copy-only assets, imported sibling configuration, data loaders, script-free allowances, unresolved imports, and label inheritance. The CI matrix includes Bun 1.3.13, 1.4.0, and 1.4.2 on Linux and macOS. The distributed CLI smoke test runs outside the checkout without external npm dependencies.

[PR #27](https://github.com/sakajunquality/bunko/pull/27) reports Temporal workflow completion and Snowflake minicore loading on amd64/arm64 at a source checkpoint. Those author-reported checks do not certify the exact released RC or complete application behavior.

Private application compatibility is not established by these fixtures. Complete HTTP behavior, native functionality, database operations, runtime files, and both target Linux architectures still need workload validation. Use independently authored fixtures in public CI; do not copy private application code or configuration.

Subsequent work includes workload validation and evaluation of source-preserving mode. Opt-in [runtime injection](RUNTIME_INJECTION.md) is included in rc.2, with signed release verification and composed-image checks. It does not preserve source locations or install addon libraries. Database migrations should run as explicit one-off operations, not implicitly on every HTTP startup.


## Multiple entrypoints in one image

Bundle mode supports named entries with an explicit default:

```json
{
  "bunko": {
    "entrypoints": {
      "server": "src/server.ts",
      "worker": "src/worker.ts",
      "migrate": "scripts/migrate.ts"
    },
    "defaultEntrypoint": "server",
    "args": ["--serve"]
  }
}
```

Every entry is validated and bundled, including shared chunks and runtime assets. The image uses `Entrypoint=[bun]` and `Cmd=[default emitted file,...args]`, so a deployment can override the command without replacing the Bun interpreter:

```sh
docker run --rm example/image /app/src/worker.js
docker run --rm example/image /app/scripts/migrate.js --check
```

The report's `images[].entrypoints` maps names to absolute image paths. The default is reported as `defaultEntrypoint`. Output paths follow the source layout and include every selected entry in cache identity. Omitted or ignored secondary entries and colliding output names fail before building. Change the workdir-aware paths if you configure a different image workdir.

Use either the existing `entrypoint` setting or `entrypoints`. The existing single-entry image contract is unchanged. Named entries currently require bundle mode; compile mode rejects them. A single named entry can omit `defaultEntrypoint`. URI fragments are not introduced: `bunko://` continues to refer to the complete target image. Kubernetes `args` can select a different emitted entry in that image. Migrations remain explicit one-off commands.

Named-entry images always enable code splitting, including a single named entry. Container Cmd/Kubernetes args provide Bun arguments directly and can invoke other Bun CLI operations; the entry map is a deployment convenience, not a runtime command allowlist. Treat permission to override these arguments as permission to select what the container executes.
## Named local asset contexts

Use `assetMappings` for runtime files outside the project. Bind each logical context to a local directory at invocation time; host paths do not belong in package.json.

```json
{
  "bunko": {
    "assetMappings": [
      { "context": "repo", "from": "config/generated", "to": "/repo/config" },
      { "context": "repo", "from": "schema.sql", "to": "/repo/schema.sql" }
    ],
    "env": { "REPO_ROOT": "/repo" }
  }
}
```

```sh
bunko build ./server --asset-context repo=/path/to/staged-inputs --oci-layout ./image
```

`from` is an exact relative file or directory, without globs or parent traversal. A directory copies its contents recursively into the exact absolute image directory specified by `to`; a file maps to that exact filename. Existing `assets` patterns remain relative to the application's workdir. `--asset-context` is repeatable and works with build, resolve, apply, check-config, and doctor; it is independent of resolve's `--context`. Relative context paths, including programmatic `assetContexts` values, resolve from the invocation working directory.

Only selected files are read and frozen before dependency installation or bundling. Unselected sibling directories are not scanned. Context-root `.bunkoignore` rules and the normal credential, dependency, output, and cache exclusions apply; an excluded file anywhere in a selected tree fails the build. Symlinks and special files are rejected, including symlinks in selected parent paths. Empty directories are preserved. Files normalize to mode 0755 when any executable bit is set and 0644 otherwise; directories use 0755. This matches ordinary assets and makes packaged files readable by the configured runtime user. Live input trees should remain unchanged during staging.

Mappings cannot target system directories such as `/usr`, `/etc`, or `/proc`, or Bunko's dependency directories. Collisions between mappings, regular assets, dependencies, and application output fail, including case collisions and file/directory conflicts. Custom destinations follow normal OCI layering over the chosen base; mappings are not a general base-filesystem inspection feature.

Reports and provenance record logical context names, selected relative paths, exact destinations, and content digests. Asset cache identity includes these mappings and the frozen contents; host input directory paths are omitted. These logical names and relative paths are public metadata when publishing provenance, so choose names appropriate for publication. Additional source files copied as assets do not become executable bundle inputs. This feature does not make missing runtime dependencies or shared libraries available.

### Image and URL asset sources

A mapping can name an external source instead of a local context. Use `image` for a file or directory that already exists in another image, and `url` for a single published file with a known checksum. Exactly one of `context`, `image` and `url` may be present.

```json
{
  "bunko": {
    "assetMappings": [
      { "image": "ghcr.io/OWNER/spannerdef:v0.6.1", "from": "/usr/local/bin/spannerdef", "to": "/app/bin/spannerdef", "mode": "0755" },
      { "url": "https://github.com/OWNER/spannerdef/releases/download/v0.6.1/spannerdef-linux-amd64", "sha256": "<64 hex characters>", "to": "/app/bin/spannerdef", "mode": "0755" }
    ]
  }
}
```

`image` accepts any reference the base setting accepts and uses the same registry credentials. It is resolved once per target platform: a multi-platform index selects the manifest matching the platform being built, so one mapping produces the right binary for `linux/amd64` and `linux/arm64`. A tool image published for a single platform can be pinned with `"platform": "linux/amd64"`, which then supplies the same content to every target platform; use it only when that is what you intend. Tags are accepted, but `--reproducible` requires `image@sha256:...`. `from` is an exact absolute path inside that image, without globs or `..`; a file maps to the exact filename `to`, and a directory copies recursively into `to`.

Layers are applied in order with whiteout semantics, so the mapping sees the same filesystem a container would: a file deleted by a later layer is not copied, and a replaced file is copied at its final version. Directories that a layer populates without writing their own header are resolved as directories, as an extractor would create them, including a directory a whiteout removed and a later layer repopulated. An implied directory never displaces something that is still there: a surviving symlink or file at that path stays visible and the selection is rejected, so only an explicit header or whiteout changes what a path is. Selecting a file that a later layer populated through without replacing it is rejected rather than silently dropping those entries. Only regular files and directories are extracted. Symlinks, hard links, device nodes and sockets inside the selection are rejected, and a selection whose parent path passes through a link is rejected rather than resolved; name the resolved path instead.

The selected content is bounded to 512 MiB and 20,000 entries, counting directories, implied parent directories, and every version a later layer replaces or deletes, not only the surviving files. The bound measures extraction work, so it never decreases as layers are applied. These are bounds on the selection, not on temporary disk: layers are decoded in full before entries are filtered, under the separate 2 GiB decoded-layer limit, so peak scratch space during extraction follows the source image's layer sizes. Prefer a small purpose-built tool image over a general-purpose one.

`url` sources reach whatever the build host can reach, including private and link-local addresses, and the request is made before the checksum can be verified. A URL in a project's `package.json` is therefore a request the build host makes on the project's behalf. This matches the trust boundary in [SECURITY.md](../SECURITY.md): build untrusted projects on isolated runners.

`url` fetches exactly one file, so it never produces a directory. Only `https:` is accepted, without userinfo or a fragment, and no authorization header is ever sent; a private artifact belongs in an asset context. At most four redirects are followed, and every hop must stay on the original host, a subdomain of it, or — for GitHub release downloads — one of GitHub's own release-asset hosts. The body streams to a temporary file under a 512 MiB cap and is checked against `sha256`, which is mandatory; a mismatch fails the build and names both digests. Files default to non-executable, so set `"mode": "0755"` for a binary.

Both sources are cached under `--asset-cache` (default `~/.cache/bunko/assets/v1`, disabled by `--no-local-cache`): URL files by their declared digest, and extracted image subtrees by resolved image digest, selection and mode, beside a manifest recording each entry's path, type, executable bit, size and SHA-256. A repeated build re-resolves the reference but transfers no layer bytes. Nothing is packed straight from a cache: every entry is copied into private build staging through a single descriptor and checked against its digest on the way, and only that private copy is hashed and packed. A mismatch discards the cache entry and fetches or extracts a verified replacement, except offline, where it fails with the mismatch. Like the layer cache, the asset cache is trusted build input and its writers must be trusted; the difference is that corruption or substitution is detected rather than inherited.

Starting with 0.1.4, platform descriptors carrying an OCI or Docker image-config `artifactType` are selectable; other artifact types are skipped, and the selected manifest's config is still validated. Layer names with leading `/` or `./` prefixes are interpreted relative to the container root, including ko's `/ko-app/` entries. Traversal and interior empty/dot path segments remain rejected. This does not relax the selected symlink/hardlink restriction.

`--offline` uses a cached URL file and fails clearly when it is absent; image sources need a registry and are rejected offline. Reports and provenance record the mapping without host paths, including the resolved platform manifest digest for `image`, the `url`/`sha256` pair for `url`, and the target platforms each material was resolved for.


## Before workload validation

Follow [application validation](APPLICATION_VALIDATION.md) for a disposable functional fixture, private output handling, and the remote acceptance checklist. `check-config` and `doctor` require bindings for selected local asset mappings and inspect selected filesystem entries without copying or hashing their contents. `image` and `url` mappings need no binding and are neither resolved nor fetched: they are validated, listed by reference or URL, and counted separately as uninspected external sources. They report named entries, the default command, logical mappings, and selected entry counts. They reject missing inputs, normal source omissions, context-root `.bunkoignore` exclusions, symlinks, mapping collisions, and overlap with the configured runtime. Build-specific output/cache/staging-directory exclusions are checked only during a build. Regular project assets, bundle/dependency collisions, file content, and actual runtime behavior still require a build and runtime checks.

Strict undeclared-import checks enforce the importing package's manifest, not the availability of an application-level fallback. Adding an application dependency and external does not repair that declaration; use the advisory policy for this workaround and test the runtime. Probes the package guards itself are reported only under `"strict"`; unused shipped files can still produce findings.

Build reports include closure sizes only when bunko projects the dependency closure. Prepared dependency artifacts do not carry closure accounting and omit that field, even if the selected strategy is closure.

Offline diagnostics validate remote mapping syntax and destinations. They cannot inspect image/URL contents or determine collisions involving remote entries; a build performs those checks. Local and URL mappings are captured once per build target and shared across its platforms, including when image mappings are present.
