# Cookbook: build and deploy an application

Start with the task below, then follow its reference link for the complete contract. Snippets belong inside your application's `package.json`; preserve its other fields. Commands assume Bun is installed and `bunko` is on PATH. Replace registry, image and checksum placeholders with your own values. `--deep`, base capability reports, explicit-only registry cache writes, import acknowledgements and rejection of explicit credential/internal assets in bundle mode require 0.4.0 or later.

- [Ship gitignored frontend output](#ship-gitignored-frontend-output)
- [Add fonts and verify the renderer](#add-fonts-and-verify-the-renderer)
- [Copy a binary from another image](#copy-a-binary-from-another-image)
- [Fetch a pinned public file](#fetch-a-pinned-public-file)
- [Publish with existing registry credentials](#publish-with-existing-registry-credentials)
- [Run migrations or a worker from the same image](#run-migrations-or-a-worker-from-the-same-image)
- [Configure native TLS trust](#configure-native-tls-trust)
- [Choose a base without runtime surprises](#choose-a-base-without-runtime-surprises)
- [Check inputs before a build](#check-inputs-before-a-build)
- [Follow an older example](#follow-an-older-example)

## Ship gitignored frontend output

Generate the frontend first; Bunko does not execute build scripts for you. Declare the generated directory explicitly:

```json
{"bunko":{"mode":"source","assets":["dist"]}}
```

```sh
bun run build
bunko check-config . --deep
bunko build . --push=false --oci-layout ./image --report ./image-report.json
```

Replace `dist` with `build` or the specific generated paths your framework actually loads. A `.next` directory alone is not a portable Next.js deployment: follow that framework's runtime/output contract and include every required generated file. Source-mode declared assets override `.gitignore` starting in 0.3.1. `.bunkoignore`, credential exclusions and output/cache exclusions still apply. Incidental `.DS_Store` files are skipped. [Source mode](SOURCE_MODE.md), [asset selection](CONFIGURATION.md).

## Add fonts and verify the renderer

Vendor fonts and their licenses in a dedicated context:

```json
{"bunko":{"assetMappings":[
  {"context":"fonts","from":"NotoSansCJKjp-Regular.otf","to":"/usr/share/fonts/NotoSansCJKjp-Regular.otf","mode":"0444"},
  {"context":"fonts","from":"LICENSE.txt","to":"/usr/share/fonts/LICENSE.txt","mode":"0444"}
]}}
```

```sh
bunko check-config . --deep --asset-context fonts=./vendor/fonts
bunko build . --asset-context fonts=./vendor/fonts --push=false --oci-layout ./image
```

In the renderer, select the family and fallback stack explicitly, for example `"Noto Sans CJK JP", "Noto Color Emoji"` after packaging both faces. Verify a CJK string and an emoji through the actual application's rendering endpoint; the existence of a font file does not prove family selection or glyph coverage. For the pinned Resvg fixture, use `fontDirs: ["/usr/share/fonts"]` or an application `fonts.conf`; system scanning alone may find nothing in a slim base. The [font guide](FONTS.md) provides registration examples and `bun run test:fonts` for a checkout of this repository.

## Copy a binary from another image

Use an immutable image reference and the source platform that matches the application:

```json
{"bunko":{"assetMappings":[
  {"image":"registry.example/team/tools@sha256:<64-hex-image-digest>","from":"/usr/local/bin/migrate","to":"/app/bin/migrate","mode":"0755"}
]}}
```

```sh
bunko build . --platform linux/amd64 --push=false --oci-layout ./image
```

Replace the placeholder digest before running. Image mappings follow the selected target platform unless a compatible mapping platform is explicit. Bunko copies files, not the source image's shared libraries, users or CA configuration. Execute the copied binary in the final image to check its ABI and TLS behavior. [Image assets](APPLICATION_COMPATIBILITY.md), [mapping configuration](CONFIGURATION.md), [Dockerfile migration](MIGRATING_FROM_DOCKERFILE.md).

## Fetch a pinned public file

```json
{"bunko":{"assetMappings":[
  {"url":"https://example.com/releases/v1/data.bin","sha256":"<64-hex-file-sha256>","to":"/app/data.bin","mode":"0444"}
]}}
```

```sh
bunko check-config . --deep
bunko build . --push=false --oci-layout ./image
```

Use a real HTTPS URL and the expected SHA256 obtained through a trusted source. Deep checks validate the shape but do not fetch the URL; the build verifies downloaded bytes. Remote font bytes and image-source paths cannot be validated offline before acquisition. [URL assets](CONFIGURATION.md).

## Publish with existing registry credentials

Bunko reads Docker credentials and credential helpers. Log in before building; do not put tokens in package.json or image build arguments.

```sh
# GHCR: use a token authorized to publish the selected package.
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin

# Artifact Registry: configure the helper for the destination host.
gcloud auth configure-docker asia-northeast1-docker.pkg.dev

# ECR: authenticate the actual account and regional endpoint.
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
```

Set `IMAGE_REPO` to the full repository, for example `ghcr.io/OWNER/app`, `asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY/app`, or `ACCOUNT.dkr.ecr.REGION.amazonaws.com/app`:

```sh
bunko build . --repo "$IMAGE_REPO" --bare --tag "$GIT_SHA"
```

Version 0.4.0 reads legacy image-repository cache records but writes remote cache only when explicitly configured. For a shared build cache, use both directions:

```sh
bunko build . --repo "$IMAGE_REPO" --bare --tag "$GIT_SHA" \
  --cache-from "type=registry,repo=$CACHE_REPO" \
  --cache-to "type=registry,repo=$CACHE_REPO"
```

In 0.3.2 and earlier, use a separate `--cache-repo` or `--cache-write=false` to avoid implicit cache tags in the image repository. [Registry setup and verified providers](REGISTRIES.md), [cache cleanup](CACHE_RETENTION.md).

## Run migrations or a worker from the same image

```json
{"bunko":{"entrypoints":{"server":"src/server.ts","migrate":"scripts/migrate.ts","worker":"src/worker.ts"},"defaultEntrypoint":"server"}}
```

```sh
bunko build . --repo "$IMAGE_REPO" --bare --tag "$GIT_SHA" --report ./image-report.json
# Run the paths recorded in images[].entrypoints, not an assumed source path.
docker run --rm "$IMAGE_REPO:$GIT_SHA" /app/scripts/migrate.js
docker run --rm "$IMAGE_REPO:$GIT_SHA" /app/src/worker.js
```

These example paths are for bundle mode with the illustrated entries. Use the report's actual emitted paths for custom workdirs or source mode. Kubernetes `args` can select the workload while preserving the image's Bun ENTRYPOINT; schedule the migration as a Job and recurring work as a CronJob. No shell is required. [Named entrypoints](APPLICATION_COMPATIBILITY.md#multiple-entrypoints-in-one-image).

## Configure native TLS trust

```json
{"bunko":{"runtime":{"caCertificates":["certs/roots.pem"],"systemCaTrust":true}}}
```

```sh
bunko check-config . --deep
bunko build . --push=false --oci-layout ./image
```

Provide public trust certificates, never a private key. `systemCaTrust` sets image-wide `SSL_CERT_FILE` for clients that honor it and replaces an inherited file setting. Include the full public/private roots affected clients need; this is not automatically merged with the base store. `SSL_CERT_DIR` is unchanged and individual libraries may use another trust mechanism. Verify the native workload against real TLS or a disposable TLS fixture. [CA configuration](CONFIGURATION.md#application-ca-certificates).

## Choose a base without runtime surprises

```sh
bunko check-base --base oven/bun:1.4.2-slim --platform linux/amd64
bunko build . --base oven/bun:1.4.2-slim --push=false --oci-layout ./image --report ./image-report.json
bunko check-base --base oven/bun:1.4.2-distroless --platform linux/amd64 \
  --requirements-report ./image-report.json
```

The capability report lists CA paths, fonts/fontconfig, shells, the declared user/workdir and shared-library candidates. `missingFromBase` names a required library and the native file that requires it. It does not prove a runtime failure: application layers may supply libraries; a present filename does not prove loader visibility, architecture or ABI compatibility. `check-base --run` executes Bun's revision probe, not every application addon. Run the actual native workload too.

A shell-free base cannot execute `sh -c`; invoke an executable directly. No CA store or fonts can be acceptable when the application does not use them. A missing `libgcc_s` or `libstdc++` may require a different/custom base; Bunko does not install operating-system packages. [Base diagnostics](BASE_CAPABILITIES.md), [runtime contracts](APPLICATION_COMPATIBILITY.md).

## Check inputs before a build

```sh
bunko check-config . --deep --format text
```

This validates current local inputs without a bundler, dependency installation, registry or Docker daemon. Text output states the number of unchecked categories. Remote contents, future generated outputs, dynamic output collisions and runtime compatibility still need a real build or execution. Deep validation can read the selected source tree and font contents, so it takes longer than configuration-only validation. [Configuration](CONFIGURATION.md).

## Follow an older example

| Change | What to do now |
| --- | --- |
| Inherited root user behavior changed in 0.1.1 | Default builds replace inherited root with a nonroot user; explicit `bunko.user` remains policy. Review volume permissions and executable/file modes. |
| Bun minimum became 1.3.13 in 0.2.0 | Use Bun >=1.3.13 <1.5 for current releases; immutable 0.1.4 remains available for 1.3.11/1.3.12. |
| Explicit source assets override gitignore since 0.3.1 | Declare generated output directly after generating it; other exclusions still apply. |
| Version 0.4.0 makes registry cache writes explicit | Configure `--cache-repo` or `--cache-to` if you want remote cache exports; reads and managed local caching remain available. |

See [release evidence](validation/) for the exact tested versions and provider limits. Recipes do not certify arbitrary third-party bases or application frameworks.

Version 0.4.0 also rejects explicitly selected credential/internal names (such as `.env`) in bundle-mode assets; earlier versions could silently omit them. Remove those paths from the selection or narrow it with asset exclusions.
