# CJK and emoji rendering

This runnable example uses the Bunko CLI from rc.4 or later, a digest-pinned Bun slim base, Canvas 1.0.5 and Resvg 2.6.2. It verifies rendering and prints a JSON result; it is not an HTTP server. Run commands from the Bunko repository root.

## Run the complete validation matrix

Requires Bun, Python 3, Docker and network access for initial downloads. Docker must support the selected Linux architecture through a native runner or emulation.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run test:fonts
```

The runner creates temporary inputs, downloads checksum-pinned fonts and their OFL licenses, builds both bundle and source images, and removes its temporary files and application image tags. It runs both Linux amd64 and arm64 by default. For a single native Linux runner:

```sh
BUNKO_SMOKE_PLATFORMS=linux/amd64 bun run test:fonts
```

For each mode/platform, two recipes must match explicitly registered font pixels:

| Recipe | Resvg configuration | Required image configuration |
| --- | --- | --- |
| `fontconfig` (default) | `loadSystemFonts: true` | Package `fonts.conf` and set `FONTCONFIG_FILE=/app/fonts.conf` |
| `directories` | `loadSystemFonts: false`, `fontDirs: ['/usr/share/fonts/bunko']` | No fontconfig file needed |

The directory recipe is also run with a missing `FONTCONFIG_FILE` to prove that it works independently. Negative controls require clear failures when the system recipe loses its fontconfig file or Canvas system scanning is disabled. Every container uses UID 65532, a read-only root filesystem, no network, dropped capabilities and no font-cache generation. Resvg color emoji support is not asserted. Negative controls describe these pinned renderer versions and base; re-check discovery behavior when upgrading them.

## Prepare inputs and build manually

Choose a new output directory; the downloader refuses to overwrite an existing directory. Keep both upstream license files alongside the fonts.

```sh
bun scripts/validation/font-inputs.ts /tmp/bunko-font-inputs-example
bun dist/bunko.js build examples/font-validation \
  --asset-context fonts=/tmp/bunko-font-inputs-example \
  --platform linux/arm64 --mode bundle --push=false \
  --tarball /tmp/bunko-font-example.tar --git-metadata=false

docker load --input /tmp/bunko-font-example.tar
```

Use the image reference printed by `docker load` as `IMAGE` below. Choose `linux/amd64` instead on an amd64 machine, or use emulation. Set `--mode source` to preserve the application's source layout.

```sh
docker run --rm --platform linux/arm64 --user 65532:65532 \
  --read-only --network=none --cap-drop=ALL --security-opt=no-new-privileges IMAGE

docker run --rm --platform linux/arm64 --user 65532:65532 \
  --read-only --network=none --cap-drop=ALL --security-opt=no-new-privileges \
  --env FONT_DISCOVERY=directories \
  --env FONTCONFIG_FILE=/missing-fontconfig.conf IMAGE
```

Success prints `status: "passed"`, the selected recipe, architecture and pixel digests. Remove the manually created input directory, archive and image when finished.

## Adapt to an application

Copy the `bunko` configuration from [package.json](package.json), select your own entrypoint and retain the native renderers in `external`. Supply the named font context at build time. For Resvg, copy the applicable options from [rendering.mjs](rendering.mjs). If using the directory recipe exclusively, remove `assets: ["fonts.conf"]` and the `FONTCONFIG_FILE` environment setting.

For Canvas, keep system font loading enabled and set the family stack explicitly:

```js
const context = canvas.getContext('2d');
context.font = '40px "Noto Sans CJK JP", "Noto Color Emoji"';
context.fillText('日本語 😀', 5, 60);
```

If using a custom workdir, adjust the application-owned fontconfig path. The mapped `/usr/share/fonts/bunko` path is absolute and independent of workdir.

## Diagnose a failure

| Symptom | Check |
| --- | --- |
| Canvas cannot find a family | Map to `/usr/share/fonts`, retain readable file permissions and unset `DISABLE_SYSTEM_FONTS_LOAD` |
| Canvas CJK works but emoji are monochrome/missing | Include `Noto Color Emoji` in the family stack; confirm the selected face supports the glyph |
| Resvg produces blank text | Use the directory recipe or provide a readable `FONTCONFIG_FILE` with the mapped directory |
| Native renderer fails to load | Verify runtime externals, Linux architecture and native shared libraries in the explicit base |
| `Invalid system font` | Check that the downloaded file is the font itself, not an HTML download/error page |

See [the font policy and validation evidence](../../docs/FONTS.md) for formats, destination restrictions, licenses and renderer limitations.
