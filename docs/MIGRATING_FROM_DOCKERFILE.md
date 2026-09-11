# Migrating from a Dockerfile

Bunko has no Dockerfile and no `RUN`. Image content comes from three sources: the base image, the dependency/asset/application layers Bunko generates, and `package.json#bunko` settings that become image configuration. This page maps each Dockerfile instruction and the common `docker/build-push-action` inputs to their Bunko equivalents. Setting names are defined in [SPEC.md](SPEC.md#3-inputs-configuration-and-dependencies) and [CONFIGURATION.md](CONFIGURATION.md); CLI options are listed in [SPEC.md §2](SPEC.md#2-cli-and-results) and the Action inputs in [CI.md](CI.md).

## Instruction mapping

| Dockerfile | Bunko | Notes |
| --- | --- | --- |
| `FROM oven/bun:1.3` | `bunko.base`, `--base`, `BUNKO_DEFAULT_BASE` | Default is `oven/bun:<selected Bun version>-distroless`. Pin by digest (`oven/bun@sha256:...`) for reproducible builds; `--reproducible` requires it. Precedence: CLI > environment > package.json > default. Native addons need an explicit base containing their shared libraries. |
| `FROM golang AS tool` / `RUN go install ...` | none; see `COPY --from` | Bunko does not execute build stages. Copy the binary from an image that already publishes it, fetch a released binary by checksum, or produce it in a separate CI step. |
| `RUN apt-get install ...` | none | Choose a base that already contains the libraries. A base without Bun can receive a [signed runtime injection](RUNTIME_INJECTION.md). |
| `COPY package.json bun.lock` + `RUN bun install --production` (deps stage) | automatic | Bundle mode inlines dependencies; only `bunko.external` packages are installed for the image with `--production --os=linux --cpu=... --ignore-scripts --linker=isolated`. `deps.strategy: "production"` (default) keeps the whole production tree; `"closure"` keeps only instances reachable from the externals. A text `bun.lock` is required. |
| `COPY src ./src` + `COPY tsconfig.json` | `bunko.entrypoint` | Bundle mode (default) emits one bundled server file; `mode: "source"` preserves the sanitized source tree and runs the entrypoint with `--no-install` ([SOURCE_MODE.md](SOURCE_MODE.md)). Entrypoint precedence is `bunko.entrypoint > bin > module > main > src/index.ts > index.ts`. |
| `COPY db ./db` (data files) | `bunko.assets` | Project-relative files, directories or globs placed under the workdir. `assetExcludes` and `assetMode` narrow and set modes. |
| `COPY --from=tool /go/bin/tool /usr/local/bin/` | `bunko.assetMappings` with `image`, `url` or `context` | `{ "image": "...", "from": "/go/bin/tool", "to": "/app/bin/tool" }` copies straight out of another image, resolved per target platform; `{ "url": "...", "sha256": "..." }` fetches one released file over HTTPS and verifies it; `context` still binds a directory a CI step prepared, via `--asset-context NAME=DIR`. `to` is an exact absolute path; `/usr`, `/etc` and other system roots are protected, so use a path such as `/app/bin/tool`. Set `"mode": "0755"` explicitly for executables. |
| `ENV NODE_ENV=production` / `ENV PORT=8080` | `bunko.env` | `NODE_ENV=production` is set by default. Order: base Env, then `NODE_ENV`, then application overrides. |
| `EXPOSE 8080` | `bunko.ports` | Array of integers. |
| `USER bun` | `bunko.user`, `--image-user` | In CLI 0.1.1, precedence is explicit setting, nonroot base User, then `65532:65532`; inherited UID 0 (including zero-padded spellings) and `root` are replaced. CLI 0.1.0 preserves an explicit base root user, so set `"user": "65532:65532"` explicitly when using that version. Set `"user": "0:0"` explicitly only when root is required. |
| `WORKDIR /app` | `bunko.workdir` | Default `/app`. The directory must be absent or empty in the base. |
| `CMD ["bun", "src/index.ts"]` | Entrypoint is generated | Image `Entrypoint` is `[runtime.bunPath, <workdir>/<emitted entry>]` and `Cmd` is `bunko.args` (default `[]`). `bunko.runtime.args` / `--runtime-arg` adds Bun flags before the entry. Named `entrypoints` let a deployment select another emitted file through `Cmd` ([multiple entrypoints](APPLICATION_COMPATIBILITY.md#multiple-entrypoints-in-one-image)). A platform command override (for example a Cloud Run job running `/app/bin/tool`) works as with any image. |
| `COPY --from=... /etc/ssl/certs/ca-certificates.crt` | usually none | `oven/bun:*-distroless` ships `/etc/ssl/certs/ca-certificates.crt` and sets `SSL_CERT_FILE` to it, which Bun and Go binaries honor. Private CAs for the application go in `bunko.runtime.caCertificates` (`NODE_EXTRA_CA_CERTS`); add `runtime.systemCaTrust: true` to also set `SSL_CERT_FILE` for native clients. |
| `LABEL` | `bunko.labels`, `--image-label`, `bunko.annotations` | Git revision/source labels are added automatically unless `--git-metadata=false`. |
| `ARG` build constants | `bunko.build.define`, `--define` | Values are embedded in the bundle; not a secret channel. |
| `.dockerignore` | `.bunkoignore` | Positive root-relative globs only. `.git`, `node_modules`, `.env*`, `.npmrc`, credential directories and output paths are always excluded. |
| `HEALTHCHECK` | none | Use the platform's health probes. |

## Workflow mapping

| docker/build-push-action | Bunko CLI | Build Action input |
| --- | --- | --- |
| `tags: registry/repo/app:sha` | `--repo registry/repo` (+ `imageName`) or `--repo registry/repo/app --bare`; `--tag sha --tag latest` (default: `latest` and the Git revision) | `repo`, `bare`, `tags` |
| `push: true` | default; `--push=false` disables | `push` |
| `platforms: linux/amd64,linux/arm64` | `--platform linux/amd64,linux/arm64` | `platforms` |
| `cache-from/cache-to: type=gha` | the managed cache directory persisted with the GitHub Actions cache, or `--cache-repo` / `--cache-from` registry caches carrying layers and closure plan indexes | `cache: github` (no `actions/cache` step of your own), `cache-repo`, `cache-from` |
| `load: true` | `--local` (single platform, needs Docker) | not in the Action |
| `outputs: type=oci` | `--oci-layout DIR`, `--tarball FILE` | `export-layout` |
| `build-contexts: name=path` | `--asset-context NAME=DIR`, or an `image`/`url` asset mapping needing no CI step | `asset-contexts` |
| `docker/setup-buildx-action` | not needed | build, publish and export do not use a Docker daemon |
| digest output | stdout `repo@sha256:...`, `--image-refs FILE`, `--report FILE` | `digest`, `reference`, `images`, `image-refs`, `report` outputs |

Registry authentication still uses `docker login` credential configuration or provider OIDC steps; see [REGISTRIES.md](REGISTRIES.md).

## Things that differ from a Dockerfile build

- **Isolated `node_modules`.** Installs use `--linker=isolated`, and closure projection links only declared dependency edges. A package that requires something it does not declare works under a hoisted `bun install` in a Dockerfile and fails at runtime here, for example `grpc-gcp` requiring `protobufjs`, or `@google-cloud/opentelemetry-resource-util@2.4.0` (pinned by `@google-cloud/spanner` 8.x as `^2.4.0`), whose `build/src/detector/gce.js` requires `@opentelemetry/api` while declaring only `@opentelemetry/resources` as a peer; 3.x adds the missing peer. Fix: update the package, or add the missing package to your own `dependencies` and to `bunko.external` so it is installed next to the package that needs it.
- **Install scripts never run.** Runtime packages declaring `preinstall`/`install`/`postinstall` are rejected unless listed in `deps.allowIgnoredScripts` (for example `protobufjs`, whose hook only prints a notice). An allowance does not generate files the hook would have produced.
- **Bundling relocates modules.** Packages that read files relative to `__dirname` or `import.meta.dir` (`google-gax`, `@grpc/grpc-js`, `@google-cloud/spanner` and other `.proto` loaders) must stay in `bunko.external` so their files remain at their package paths. Builds report `BUNKO_MODULE_LOCATION` diagnostics; see [module-relative runtime files](APPLICATION_COMPATIBILITY.md#module-relative-runtime-files).
- **The Bun version comes from the host.** A Dockerfile pins Bun with the `FROM` tag; Bunko uses the selected host Bun (PATH or `--bun-path`) and derives the default base from it. Pin it with an exact `packageManager: "bun@1.4.2"` or `bunko.toolchain.version`, and pass the same version to the setup Action's `bun-version`. Ranges are not accepted.
- **No Docker daemon.** Building, publishing and exporting layouts need no daemon; only `--local` and `--kind` do. Registry logins are read from Docker's credential configuration.
- **Frozen inputs.** The lock must already match `package.json`; installs never rewrite either file. Checkout `node_modules` are never copied.

## Binaries from other toolchains

A statically linked Go binary such as [spannerdef](https://github.com/nao1215/spannerdef), needed by a migration job in the same image, is declared in `package.json` and needs no CI step:

```json
{
  "bunko": {
    "assetMappings": [
      { "image": "ghcr.io/OWNER/spannerdef@sha256:<digest>", "from": "/usr/local/bin/spannerdef", "to": "/app/bin/spannerdef", "mode": "0755" }
    ]
  }
}
```

When the tool is published as a release file rather than an image, fetch it by checksum instead:

```json
{
  "bunko": {
    "assetMappings": [
      { "url": "https://github.com/OWNER/spannerdef/releases/download/v0.6.2/spannerdef-linux-amd64", "sha256": "<64 hex characters>", "to": "/app/bin/spannerdef", "mode": "0755" }
    ]
  }
}
```

`image` mappings resolve per target platform, so a multi-platform tool image serves both `linux/amd64` and `linux/arm64` from one entry; a `url` mapping names one exact file, so select the architecture you build for or use an image source. `--reproducible` requires `image@sha256:...`. Both are described in [image and URL asset sources](APPLICATION_COMPATIBILITY.md#image-and-url-asset-sources).

## Not yet supported

- `RUN` or any build-time command execution inside the image.
- Authenticated URL downloads. `url` mappings send no credentials; use an `image` mapping, which reuses registry credentials, or an asset context for a private file.

## Before and after

Dockerfile:

```dockerfile
FROM golang:1.25 AS tool
RUN go install example.com/tool/cmd/tool@v1.2.3

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.3
ENV NODE_ENV=production
COPY --from=tool /go/bin/tool /usr/local/bin/tool
COPY --from=tool /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY db ./db
ENV PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "src/index.ts"]
```

Workflow step:

```yaml
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    context: .
    platforms: linux/amd64
    push: true
    tags: |
      REGION-docker.pkg.dev/PROJECT/REPO/backend:${{ github.sha }}
      REGION-docker.pkg.dev/PROJECT/REPO/backend:latest
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

`package.json`:

```json
{
  "packageManager": "bun@1.4.2",
  "bunko": {
    "entrypoint": "src/index.ts",
    "imageName": "backend",
    "external": ["@google-cloud/spanner", "@opentelemetry/api"],
    "deps": { "strategy": "closure", "allowIgnoredScripts": ["protobufjs"] },
    "assets": ["db"],
    "assetMappings": [{ "image": "example.com/tool@sha256:<digest>", "from": "/go/bin/tool", "to": "/app/bin/tool", "mode": "0755" }],
    "env": { "NODE_ENV": "production", "PORT": "8080" },
    "ports": [8080],
    "user": "65532:65532"
  }
}
```

Workflow steps (pin Action commits as described in [CI.md](CI.md)):

```yaml
- uses: sakajunquality/bunko@<commit>
  with:
    version: v0.6.2
    bun-version: 1.4.2
- uses: sakajunquality/bunko/build@<commit>
  id: image
  with:
    path: .
    repo: REGION-docker.pkg.dev/PROJECT/REPO
    push: 'true'
    platforms: linux/amd64
    tags: |
      ${{ github.sha }}
      latest
    cache: github
```

`cache: github` replaces `cache-from/cache-to: type=gha` and the `actions/cache` step a workflow used to write by hand: the build Action restores and saves the managed cache directory itself, deriving the key from the runner, the bunko version and the lockfile and manifests under `path`. Add `cache-repo` alongside it to also share built layers across runners and repositories. See [the GitHub Actions cache](CI.md#the-github-actions-cache).

The image is `REGION-docker.pkg.dev/PROJECT/REPO/backend`; `${{ steps.image.outputs.reference }}` holds its immutable digest reference and `${{ steps.image.outputs.report }}` the build report. A job that runs the mapped binary overrides the command with `/app/bin/tool`, as it would with the Dockerfile image.
