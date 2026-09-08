# Source-preserving images

Source builds after rc.3 support `bunko build --mode source`. Bunko packages the sanitized source snapshot without invoking the bundler and installs the complete Linux production dependency tree with the frozen lockfile and scripts disabled. The immutable rc.3 distribution does not include this mode.

```sh
bunko build . --mode source --base oven/bun:1.3.11-slim \
  --push=false --oci-layout output/image
```

JavaScript/TypeScript files retain their names and relative positions. Dynamic imports, `import.meta.url`, CommonJS module locations and adjacent runtime data therefore resolve against the original source layout inside the image. TypeScript is transpiled by Bun at runtime. Package manifests and supported configuration files remain available. No bundling, minification, define substitution or source-map generation is performed; explicit bundler settings and invocation defines are rejected. Macros remain unsupported.

This mode packages the complete sanitized application context, not only statically reachable modules. Existing source exclusions still apply: credentials, `.env` files, host node_modules, Git metadata, build/cache/output directories and explicitly excluded trust inputs are omitted. Use `.bunkoignore` to reduce the source context, and keep runtime-imported packages in production dependencies. Development dependencies are not installed into the image. Bun starts with `--no-install` so missing runtime packages do not trigger automatic downloads.

For a workspace, the original workspace directory layout is preserved below `bunko.workdir` (default `/app`). The image working directory is the selected member's directory and its entry path includes the member path. All sanitized workspace source is retained, including sibling files needed by dynamic or relative references. The isolated production installation keeps its original root/member node_modules topology; peer versions and workspace links retain their context. Source-mode application cache identity uses the entire snapshot, including sibling data. Production dependency strategy is required; closure/sharedDeps relocation is rejected.

Named entrypoints preserve their original extensions and paths. As with bundle mode, a named-entrypoint image uses Bun as ENTRYPOINT and the selected source path plus application arguments as CMD; override CMD to select another reported entry path. Single-entrypoint images include the source path in ENTRYPOINT. `bunko.args` remains application arguments.

Configured source assets are already present at their original paths and are not packed twice. Explicit asset patterns are still checked; named external asset mappings remain a separate layer with collision checks. Source exclusions also apply to runtime data, so excluded required inputs cannot be restored implicitly. Installed native dependencies retain the target-platform checks and require an appropriate explicit base. This mode does not install system packages or certify every file in application source for ABI compatibility.

Runtime injection can supply a verified Bun runtime to an explicit compatible base in source mode. Offline source builds can repackage changed source when their production dependency layer and runtime inputs are already available locally, because no build-time dependency installation is needed. A missing dependency layer still fails before attempting an offline install.
