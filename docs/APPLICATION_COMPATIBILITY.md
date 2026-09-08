# Application compatibility

These capabilities are available in source builds after v0.1.0-alpha.2. They are not part of the existing immutable release assets.

## Workspaces and catalogs

Use an explicit target for mixed workspaces containing servers, mobile clients, and tooling. A native mobile client is not a Bun server image target. Workspace declarations accept an array or an object with `packages`, `catalog`, and `catalogs`. Catalogs may alternatively live at the manifest root. Do not declare the same catalog field in both locations.

Default `catalog:` and named `catalog:stable` references must resolve to registry dependency specifications. Catalog definitions, manifest declarations, and the frozen lock must agree. Installation retains the complete workspace manifest/lock topology, so catalog changes can invalidate dependency caches across targets. Target selection does not prune installation or relax workspace identity checks.

## Build input validation

The selected Bun executable runs an embedded, trusted build worker. Its `onLoad` hook validates executable bytes before returning them to the bundler. The worker never loads application-provided plugins. Worker, compile, and install subprocesses use empty, dedicated HOME and XDG configuration directories plus explicit controlled bunfig files. Real macros and unsupported or ambiguous attributes fail before macro execution. The checks apply to transitive dependencies and explicitly imported declaration-suffixed files too.

Copied assets and unreachable modules do not receive executable syntax checks. Importing a copied JS asset makes it an executable input again. Data imports with static `type: "json"`, `"text"`, `"file"`, or `"toml"` attributes are supported for explicit relative file paths, and emitted files remain part of the application layer. All loaded file inputs must remain inside the staged context. Mixing different loaders or ordinary imports with a data attribute for the same file is rejected; Bun's plugin API does not distinguish these requests reliably.

Compiler configuration checks follow loaded application inputs. Bun may consult a configuration during resolution before the hook validates it; an unsupported loaded application configuration must prevent artifact creation. An unrelated mobile package's package-based `extends` does not by itself block the selected server. Loaded application configurations still require relative extends inside the snapshot. Snapshot preflight remains conservative about inherited configuration files and exclusions; target selection is not a blanket exemption for malformed configurations or unsafe paths.

The worker carries its own parser to run under the selected Bun version, including in a standalone distributed CLI. This trades distribution size for isolated execution; it avoids scanning every installed module before a build. Validation reports count loaded executable files and bytes. Cross-worker syntax reuse is not currently reported.

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

`inheritBaseOciLabels: false` omits inherited `org.opencontainers.image.*` labels. Explicit application labels and Bunko-generated labels remain; other base labels retain their existing behavior. This option alone does not anonymize image metadata, provenance, inventories, or sourcemaps.

## Validation and remaining work

Generic fixtures cover catalog frozen installs, pre-execution macro rejection, copy-only assets, imported sibling configuration, data loaders, script-free allowances, unresolved imports, and label inheritance. The CI matrix includes Bun 1.3.11, 1.3.12, and 1.3.13 on Linux and macOS. The distributed CLI smoke test runs outside the checkout without external npm dependencies.

Private application compatibility is not established by these fixtures. Complete HTTP behavior, native functionality, database operations, runtime files, and both target Linux architectures still need workload validation. Use independently authored fixtures in public CI; do not copy private application code or configuration.

Subsequent work includes explicit external asset contexts, and evaluation of source-preserving mode. Runtime injection into custom bases remains a separate design requiring ABI and shared-library checks. Database migrations should run as explicit one-off operations, not implicitly on every HTTP startup.


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
