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
