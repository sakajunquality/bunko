# Source-preserving images

rc.4 and later support `bunko build --mode source`. Bunko packages the sanitized source snapshot without invoking the bundler and installs the complete Linux production dependency tree with the frozen lockfile and scripts disabled. The immutable rc.3 distribution does not include this mode.

```sh
bunko build . --mode source --base oven/bun:1.3.13-slim \
  --push=false --oci-layout output/image
```

JavaScript/TypeScript files retain their names and relative positions. Dynamic imports, `import.meta.url`, CommonJS module locations and adjacent runtime data therefore resolve against the original source layout inside the image. TypeScript is transpiled by Bun at runtime. Package manifests and supported configuration files remain available. No bundling, minification, define substitution or source-map generation is performed; explicit bundler settings and invocation defines are rejected. Macros remain unsupported.

This mode packages the selected application context, not only statically reachable modules. Fixed exclusions include `.env*`, host `node_modules`, Git metadata, `.npmrc`, `.docker`, `.aws`, `.config`, tool output/cache directories and explicitly excluded trust inputs. These rules do not identify every possible credential. Use `.bunkoignore` to reduce the source context, and keep runtime-imported packages in production dependencies. Development dependencies are not installed into the image. Bun starts with `--no-install` so missing runtime packages do not trigger automatic downloads.

Builds after rc.4 add fixed exclusions for `.ssh`, `.kube`, `.gnupg`, `.netrc`, `.terraform`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `terraform.tfstate`, and `terraform.tfstate.backup` in all modes. Source mode additionally applies root and nested `.gitignore` rules. Git is not required: matching uses project-local patterns, including negation and directory rules, with case-sensitive paths. Global Git excludes, `.git/info/exclude`, and tracked-file state are not consulted. An excluded parent cannot be restored by a nested ignore file. `.bunkoignore` and fixed exclusions remain authoritative. Bundle/compile snapshots retain their existing `.bunkoignore` behavior.

Explicit `bunko.assets` selections override `.gitignore`, including ignored parent directories and nested rules. Only matched files and selected directory contents are included; ignored siblings stay excluded. `assetExcludes`, `.bunkoignore`, fixed credential/output/cache exclusions, symlink rejection and private-key scanning still apply. Missing asset patterns still fail. An ignored entrypoint or configuration input that is not explicitly selected as an asset fails before registry access. `check-config` reports `explicitAssetsOverrideGitignore` for source targets; it does not check generated asset availability. When a workspace invocation includes a source-mode target, the source policy applies to its shared snapshot. Each `.gitignore` must be a regular file of at most 256 KiB; all loaded rules are bounded to 4 MiB.

Source mode rejects files containing PEM private-key markers, including markers embedded in JSON strings. This is a conservative marker check, so examples containing those markers must also be excluded. The check scans the copied snapshot with bounded memory and never prints key contents. It does not detect arbitrary API tokens or every secret format. The immutable rc.4 release predates these additional protections.

For a workspace, the original workspace directory layout is preserved below `bunko.workdir` (default `/app`). The image working directory is the selected member's directory and its entry path includes the member path. All sanitized workspace source is retained, including sibling files needed by dynamic or relative references. The isolated production installation keeps its original root/member node_modules topology; peer versions and workspace links retain their context. Source-mode application cache identity uses the entire snapshot, including sibling data. Production dependency strategy is required; closure/sharedDeps relocation is rejected.

Named entrypoints preserve their original extensions and paths. As with bundle mode, a named-entrypoint image uses Bun as ENTRYPOINT and the selected source path plus application arguments as CMD; override CMD to select another reported entry path. Single-entrypoint images include the source path in ENTRYPOINT. `bunko.args` remains application arguments.

Configured source assets are already present at their original paths and are not packed twice. Explicit asset patterns are still checked; named external asset mappings remain a separate layer with collision checks. Source exclusions also apply to runtime data, so excluded required inputs cannot be restored implicitly. Installed native dependencies retain the target-platform checks and require an appropriate explicit base. This mode does not install system packages or certify every file in application source for ABI compatibility.

Runtime injection can supply a verified Bun runtime to an explicit compatible base in source mode. Offline source builds can repackage changed source when their production dependency layer and runtime inputs are already available locally, because no build-time dependency installation is needed. A missing dependency layer still fails before attempting an offline install.

## Runtime validation

The generic application fixture passed in source mode on Linux amd64 and arm64 on 2026-09-08. Both platforms ran migrations and a worker against a disposable PostgreSQL database, served HTTP/static content and module data, loaded the native xxhash addon, and drained an in-flight request during shutdown as a nonroot user with a read-only root filesystem. CI repeats the source-mode fixture on Linux amd64. This fixture does not certify unrelated external applications.

A gitignored frontend output can be packaged directly, without a separate context or copy:

```json
{ "bunko": { "mode": "source", "assets": ["dist"], "assetExcludes": ["dist/**/*.map"] } }
```

Build the frontend first, then run `bunko build .`. An exact file or glob such as `dist/build.json` or `dist/**/*.js` also works.
