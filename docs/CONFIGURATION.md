# Shared configuration and runtime options

These settings are available in source builds after rc.3. The immutable rc.3 release does not include them.

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

## Bun runtime arguments

`bunko.runtime.args` is an array of arguments placed after the Bun executable and before the entry script. Use it for runtime flags such as `--smol` or runtime export conditions. Repeat `--runtime-arg=VALUE` to replace that array for an invocation; using `=` allows values beginning with `--`.

```sh
bunko build . --mode source --runtime-arg=--smol \
  --runtime-arg=--conditions=custom --push=false --oci-layout output
```

`bunko.args` remains application arguments after the entry script. Named entrypoints retain their CMD-based selection while Bun runtime arguments remain in ENTRYPOINT. Source mode appends `--no-install` before the entry script. Compile mode rejects runtime arguments because its entrypoint is the compiled executable; use application `args` there. Runtime flags do not change bundler resolution decisions made while building bundle-mode code. Arguments are passed as argv entries, never evaluated by a shell. Diagnostics report their count, not their values.

## Toolchain declarations

Bunko selects an already installed Bun binary using the existing PATH or `--bun-path` behavior. `bunko.toolchain.version` can require an exact supported Bun 1.3 version; `bunko.toolchain.revision` can additionally require the exact revision string printed by that binary's `bun --revision` command. No version declaration downloads or provisions a toolchain.

An exact `packageManager: "bun@1.3.11"` also constrains the selection. Bun packageManager ranges, aliases and integrity suffixes are not supported. Other package-manager names do not select Bun. Workspace-root and member Bun packageManager pins must agree with the effective Bunko version requirement. Both root and member `engines.bun` ranges must accept the selected version.

`check-config` reports the declarations without requiring Bun execution. `doctor` and builds compare them with the selected local binary before dependency installation or base-registry access. A mismatch fails with an instruction to install/select the required local binary. Runtime compatibility with a custom base remains a separate check; declarations do not certify that base's embedded Bun version.

## Asset exclusions and permissions

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

Mapping exclusions are relative to the selected `from` directory; for a single file they match its basename. Explicit exclusions run before reading descendant file contents. Existing context, symlink, reserved-destination and collision rules remain in force. File modes participate in asset material/cache identity.

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
