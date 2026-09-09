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
      "allowIgnoredScripts": ["ready-made-addon"]
    },
    "build": {
      "allowUnresolved": [""]
    },
    "inheritBaseOciLabels": false
  }
}
```

`deps.allowIgnoredScripts` accepts exact resolved package names whose published files work without their declared install hooks. Hooks are always disabled. An allowance does not generate missing files, repair a native addon, or install a shared library. Prefer externalization for native and location-sensitive packages, and exercise their real behavior in a Linux runtime test. The resolved name/version and ignored hook names appear in inventory; policy and lock inputs affect dependency cache identity. Production, workspace, and closure packaging enforce the policy. Shared dependency layers require matching allowances across targets. Prepared dependency artifacts retain their separate validation contract.

`build.allowUnresolved` uses Bun's **specifier patterns**, not importing-package names. An empty string allows opaque dependency expressions such as `require(variable)` to remain for runtime resolution. Application computed imports remain rejected, and missing literal imports still fail. An allowance does not ensure that a dynamically requested package is present. Leave the setting absent to retain strict behavior.

Packages that ship one prebuilt `.node` per platform in a single tree, such as Temporal's core bridge or Snowflake's minicore, are supported: only the target's little-endian ELF64 shared-object addons with System V/GNU OSABI are packaged. Recognized foreign signatures/architectures and links to those addons are omitted. Unknown content, truncated ELF headers and target non-shared objects remain errors. The nearest named package manifest owns each addon; unnamed module-scope manifests do not split ownership, and lookup stays inside the frozen runtime tree. A package whose addons include none for the target still fails; the runtime selection logic inside the package is not inspected. Fresh runtime walks log omission counts, prepared packing reports omitted paths, and cache hits reuse already filtered layers without recounting. Directory-enumerating loaders see the pruned tree; libc and actual addon loading still require runtime validation.

`inheritBaseOciLabels: false` omits inherited `org.opencontainers.image.*` labels. Explicit application labels and Bunko-generated labels remain; other base labels retain their existing behavior. This option alone does not anonymize image metadata, provenance, inventories, or sourcemaps.

## Validation and remaining work

Generic fixtures cover catalog frozen installs, pre-execution macro rejection, copy-only assets, imported sibling configuration, data loaders, script-free allowances, unresolved imports, and label inheritance. The CI matrix includes Bun 1.3.11, 1.3.12, and 1.3.13 on Linux and macOS. The distributed CLI smoke test runs outside the checkout without external npm dependencies.

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

## Before workload validation

Follow [application validation](APPLICATION_VALIDATION.md) for a disposable functional fixture, private output handling, and the remote acceptance checklist. `check-config` and `doctor` require bindings for selected asset mappings and inspect selected filesystem entries without copying or hashing their contents. They report named entries, the default command, logical mappings, and selected entry counts. They reject missing inputs, normal source omissions, context-root `.bunkoignore` exclusions, symlinks, mapping collisions, and overlap with the configured runtime. Build-specific output/cache/staging-directory exclusions are checked only during a build. Regular project assets, bundle/dependency collisions, file content, and actual runtime behavior still require a build and runtime checks.
