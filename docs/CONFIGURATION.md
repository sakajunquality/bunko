# Shared configuration and runtime options

These settings are available in rc.4 and later. The immutable rc.3 release does not include them.

## Workspace defaults

A workspace root can declare `bunko.defaults` for shared application settings:

```json
{
  "workspaces": ["packages/*"],
  "bunko": {
    "defaults": {
      "mode": "source",
      "workdir": "/srv",
      "user": "65532:65532",
      "runtime": { "args": ["--smol"] },
      "env": { "NODE_ENV": "production" },
      "toolchain": { "version": "1.3.11" }
    }
  }
}
```

Defaults apply to selected members and to a selected runnable workspace root. Member settings override defaults, and invocation options retain their existing precedence. Arrays replace inherited arrays. Environment, label, annotation, build, runtime, dependency-policy and toolchain maps merge by key; `build.define` also merges per define key. Set a map to `null` to clear it, for example `"build": null` when a source-mode member must clear inherited bundler settings. An empty array clears inherited runtime/application arguments or asset selections.

Entrypoints, entrypoint names, image names, target enablement and sharedDeps are not defaultable: they determine discovery or target identity. `bunko.defaults` is accepted only at the workspace root. Paths in defaults are interpreted in each selected member's context under the ordinary setting rules; shared absolute image destinations still undergo collision checks.

After rc.4, `check-config` and `doctor` report `inheritedDefaults` for each target, and build logs list inherited leaf keys. Member resets and invocation overrides are reflected in that list. Values are not logged. Review the workspace root when keys such as `user`, `deps.allowIgnoredScripts`, `runtime.inject`, or `runtime.caCertificates` are inherited: defaults are explicit shared policy, including an explicitly configured root user.

## Image user

`bunko.user` (or `--image-user`) sets the OCI `User` of the built image. Without it, a base image `User` other than root is inherited; a base `User` that is absent, empty or root (`0`, `0:0`, `00:00`, `root`, `root:root` and similar spellings) is replaced by `65532:65532`, the `nonroot` account shipped by `oven/bun:<version>-distroless`. The build logs `Base image declares User 0; running as 65532:65532` once per platform image when that replacement occurs. Set `"user": "0:0"` explicitly for a base that must run as root, and pick another user (for example `"1000:1000"`) when the base defines it.

## Undeclared runtime imports

```json
{
  "bunko": {
    "deps": { "strategy": "closure", "undeclaredImports": "warn" }
  }
}
```

`deps.undeclaredImports` controls the closure-strategy scan for packages that import a name they do not declare (see [APPLICATION_COMPATIBILITY.md](APPLICATION_COMPATIBILITY.md)). The scan covers only the files a package's entry points (`main`, `module`, `exports`, `bin`, a string `browser`) reach through relative imports, so tests and benchmarks that packages ship to npm do not produce findings; a package without any resolvable entry point is scanned whole, minus well-known test directories and file names. `warn` (default) logs one `BUNKO_UNDECLARED_IMPORT` line per package and missing name and continues; `error` fails the build when any are found; `strict` behaves like `error` and additionally logs and fails on optional imports; `off` skips the scan. Unknown values are rejected.

A missing name is *optional* when the package guards every use of it itself, across every file the scan reaches, not just the file that introduced it: every literal naming it is the argument of `require.resolve()`, or of `require()`/`import()` inside a `try` block that a `catch` handler protects, at any nesting depth. Every other position keeps the name a regular finding — a static `import`/`export … from` source, a `try` block with only a `finally`, an unprotected `catch` body, a plain string mention such as the `"x"` a computed `require(name)` later resolves — and so does anything the scan cannot lex with certainty, which disables optional classification for that package instance entirely. A reached file above the 4 MiB cap or one that will not read counts as uncertain without being read, and its own imports are never discovered. A reached file that contains no candidate name and no backslash is known to hold no occurrence and is not lexed, so only files that mention a candidate can leave doubt. The classification is textual, not an execution model: a `require()` a `try` block only defers to a callback still counts as guarded, so optional means no unguarded use was found rather than a guarantee that the package cannot crash. Optional names never appear under `warn` or `error` — they are carried in the closure result but not logged — and under `strict` they are logged after the undeclared ones, sharing the same 100-line budget, as

```text
BUNKO_OPTIONAL_IMPORT debug@4.4.3 imports "supports-color" only inside try/catch (src/node.js); treated as optional
```

and counted as failures. Use `strict` when the application must not depend on a probe degrading silently; use `error` to make genuine undeclared imports a CI failure without being blocked by probes such as the `try { require("supports-color") } catch {}` that `debug` ships. The key is a dependency-policy map entry, so a workspace root can set it in `bunko.defaults.deps` and members can override it. Targets sharing one closure under `sharedDeps` are governed by the strictest of their policies. The production strategy is unaffected: hoisted production installs resolve undeclared names the same way local development does.

## Bun runtime arguments

`bunko.runtime.args` is an array of arguments placed after the Bun executable and before the entry script. Use it for runtime flags such as `--smol` or runtime export conditions. Repeat `--runtime-arg=VALUE` to replace that array for an invocation; using `=` allows values beginning with `--`.

```sh
bunko build . --mode source --runtime-arg=--smol \
  --runtime-arg=--conditions=custom --push=false --oci-layout output
```

`bunko.args` remains application arguments after the entry script. Named entrypoints retain their CMD-based selection while Bun runtime arguments remain in ENTRYPOINT. Source mode appends `--no-install` before the entry script. Compile mode rejects runtime arguments because its entrypoint is the compiled executable; use application `args` there. Runtime flags do not change bundler resolution decisions made while building bundle-mode code. Arguments are passed as argv entries, never evaluated by a shell. Diagnostics report their count, not their values.

After rc.4, runtime arguments are validated before registry access. Bunko accepts supported runtime options, including value pairs such as `["--preload", "./preload.ts"]` or inline values such as `--conditions=custom`. Debugger options with optional values use the inline form (`--inspect=localhost:9229`) to avoid consuming the application path. Values beginning with `-` also require the inline form. Accepted value pairs and short aliases are normalized to `--flag=value`, so no value becomes a positional argument; diagnostic counts describe the normalized argv. Empty arguments, standalone scripts/subcommands, `--`, evaluation/print modes, help/version exits, and unsupported options are rejected. Use `bunko.args` for application arguments. Bun 1.3 and 1.4 have different runtime flag support; select a runtime that implements the configured options. Preload paths refer to files in the resulting image. Auto-install controls (`--install`, `-i`) and script-runner switches (`--bun`, `--if-present`) are outside the supported runtime option set. Debugger wait/break options intentionally delay application startup until a debugger attaches.

## Module-location diagnostics

Bundle and compile builds report `BUNKO_MODULE_LOCATION` warnings for loaded `import.meta.dir`/`__dirname`-style references; see [application compatibility](APPLICATION_COMPATIBILITY.md#module-relative-runtime-files) for what they mean. When a flagged file belongs to a dependency package, the build appends one hint naming the declared dependencies to add to `bunko.external`, so packages such as `@google-cloud/spanner` keep their module-relative `protos` directories in `node_modules` instead of being inlined with a build-host path.

`bunko.build.moduleLocations` accepts `"warn"` (default) or `"error"`. With `"error"`, the build fails after listing the warnings and the hint, which makes CI catch relocated dependency files before the container dies on first use. `--module-locations warn|error` overrides the manifest for one invocation and is accepted by `build`, `resolve`, `apply`, `check-config` and `doctor`. The key merges through workspace `defaults.build` like other build settings; a source-mode member must clear inherited bundler settings with `"build": null`, while the invocation override is accepted in every mode because source mode produces no such diagnostics.

## Toolchain declarations

Bunko selects an already installed Bun binary using the existing PATH or `--bun-path` behavior. `bunko.toolchain.version` can require an exact supported Bun version; `bunko.toolchain.revision` can additionally require the exact revision string printed by that binary's `bun --revision` command. No version declaration downloads or provisions a toolchain.

An exact `packageManager: "bun@1.3.11"` also constrains the selection. rc.4 and later accept stable Bun >=1.3.11 <1.5 declarations, including Bun 1.4; compile/injection support additionally requires an exact verified runtime pin. Bun packageManager ranges, aliases and integrity suffixes are not supported. Other package-manager names do not select Bun. Workspace-root and member Bun packageManager pins must agree with the effective Bunko version requirement. Both root and member `engines.bun` ranges must accept the selected version.

`check-config` reports the declarations and their sources without requiring Bun execution. `doctor` and builds compare them with the selected local binary before dependency installation or base-registry access. A mismatch fails with a message naming the selected binary path and version, the declared version, revision or range, and the declaration source (`package.json#packageManager`, `bunko.toolchain.version`, `bunko.toolchain.revision` or `<member>/package.json#engines.bun`), so the user can decide between installing/selecting the required local binary and changing the declaration. Runtime compatibility with a custom base remains a separate check; declarations do not certify that base's embedded Bun version.

## Asset exclusions and permissions

Finder `.DS_Store` entries are automatically omitted at every depth in source directories, declared asset directories, `bunkodata` and external asset directories. They do not affect snapshot or asset content hashes, and no ignore pattern is needed. Other protected names retain their existing rejection rules; explicitly selecting a `.DS_Store` file as a required source input or external mapping is unsupported.

`bunko.assetExcludes` contains positive glob patterns relative to the selected project. It narrows files selected by `assets` and the automatic bunkodata selection. Excluding a directory excludes its descendants. Required build files remain available to bundle/compile processing; source mode rejects exclusions that would remove an entrypoint or required package/configuration scope. Excluded asset-only data does not enter the source snapshot or asset layer.

`bunko.assetMode` accepts `preserve` (default), `0444`, `0555`, `0644` or `0755`. The default preserves the executable classification and uses normalized 0644/0755 permissions, not arbitrary host permission bits. Explicit modes affect selected files; directories remain 0755. Special permission bits are unsupported. In source mode, declared assets remain at their original source positions while these exclusions and file modes apply there.

External asset mappings can set `exclude` and `mode` independently:

```json
{
  "bunko": {
    "assets": ["public"],
    "assetExcludes": ["public/private", "public/*.map"],
    "assetMode": "0444",
    "assetMappings": [
      {
        "context": "generated",
        "from": "data",
        "to": "/repo/data",
        "exclude": ["private", "**/*.map"],
        "mode": "0444"
      }
    ]
  }
}
```

Mapping exclusions are relative to the selected `from` directory; for a single file they match its basename. Explicit exclusions run before reading descendant file contents. Existing context, symlink, reserved-destination and collision rules remain in force. File modes participate in asset material/cache identity. A narrow [system font exception](FONTS.md) permits validated non-executable font data and notices below `/usr/share/fonts` and `/usr/local/share/fonts`; other reserved roots remain protected.

## Application CA certificates

`bunko.runtime.caCertificates` explicitly supplies public trust certificates for the application:

```json
{
  "bunko": {
    "runtime": { "caCertificates": ["certs/service-ca.pem"] }
  }
}
```

Select up to sixteen exact paths inside the project, with no symlink traversal. Source ignore and reserved-input rules apply. Each input must contain valid PEM certificates, with annotations allowed and private keys/other PEM blocks rejected. The combined bundle is limited to 1 MiB. Bunko writes it at `<workdir>/.bunko-ca/roots.pem` with mode 0444 and sets the image's `NODE_EXTRA_CA_CERTS` to that path. Bundle, source and compile modes can use it. The base's system certificate store is not modified, and a conflicting preexisting extra-CA environment path is rejected rather than silently discarded.

Runtime certificates are explicit application inputs, distinct from installer `.npmrc` trust and registry TLS configuration. Host trust is never automatically exported. If the same certificate file is explicitly selected for runtime trust, it is allowed as an application input even when also used by host transport. Source mode otherwise preserves that public source file under its normal context rules. Reports include the generated bundle path, digest and certificate count; provenance records its digest without host paths or certificate contents. Base path metadata is checked before adding the bundle, rejecting symlink/non-directory parents and incompatible destinations.

The runtime CA bundle extends Bun/Node TLS trust; it is not a system-store installation for arbitrary native processes. `bun run test:runtime-ca-compile` builds and executes compiled images with a disposable private TLS endpoint on each selected Linux architecture. The server key is mounted only during execution, while the declared public CA is packaged in the image. The fixture exercises nonroot, read-only execution without external networking. Set `BUNKO_CLI` to a prepared JavaScript CLI to validate that exact distribution instead of source imports.
