# System fonts

Available in source builds after v0.1.0-rc.3. This is a narrow extension of `assetMappings`; Bunko does not run an OS package manager or generate a fontconfig cache.

Vendor the font files and their distribution licenses in a named local context. Map them to `/usr/share/fonts` or `/usr/local/share/fonts`, or a subdirectory below either root:

```json
{
  "bunko": {
    "assetMappings": [
      {
        "context": "fonts",
        "from": "noto",
        "to": "/usr/share/fonts/bunko",
        "mode": "0444"
      }
    ]
  }
}
```

```text
font-inputs/
  noto/
    NotoSansCJKjp-Regular.otf
    NotoColorEmoji.ttf
    OFL.txt
```

```sh
bunko build . --asset-context fonts=./font-inputs \
  --base oven/bun:1.3.13-slim --platform linux/amd64,linux/arm64 \
  --push=false --oci-layout output/image
```

Pin the base digest for reproducible builds. Do not assume a base contains the fonts or native libraries your application needs. Select explicit runtime externals for native renderers and test the resulting image. See the [pinned validation fixture](../examples/font-validation/package.json).

## Input and destination policy

- Only regular `.ttf`, `.otf`, `.ttc` and `.otc` files, plus accompanying `OFL`, `LICENSE`, `LICENCE`, `COPYING`, `NOTICE` and `README` files, are accepted in the font namespaces. Notice names may have a dot, underscore or hyphen suffix such as `LICENSE.txt` or `OFL-CJK.txt`.
- Font files must be 12 bytes–128 MiB and have bounded SFNT/OpenType table directories. Collections accept up to 64 faces. This checks the container format; it does not sanitize glyph programs or certify that a renderer can consume every font feature. Use trusted font distributions.
- Notices must be UTF-8 text without NUL bytes, at most 1 MiB each. Bunko packages selected notices unchanged; it does not infer the font license or rewrite the application SBOM as an OS package inventory. Mapping material/provenance digests cover font and notice bytes and file modes.
- Files must have non-executable resulting permissions: use `0444` or `0644`. The default `preserve` rejects executable source files. Explicit readonly modes normalize source permissions. Directories remain 0755.
- Existing context selection, exclusions, source ignore, reserved internal names, symlink and layer-collision checks apply. A regular file cannot replace either font root. Base filesystem metadata is checked for every platform; symlink/non-directory parents and incompatible existing destinations are rejected. Existing regular font files can be replaced explicitly.
- Other `/usr` destinations remain reserved. Fontconfig configuration, shared libraries, executables and cache files are not accepted through this exception.

`check-config` inspects selected names, types, modes and sizes without reading font contents. Builds validate the staged bytes before hashing or packing, including on asset-cache hits.

## Automatic discovery and explicit registration

Use `/usr/share/fonts` with `@napi-rs/canvas` 1.0.5. Its native system scan uses that absolute directory; its additional JavaScript scan of `usr/local/share/fonts` is relative to the current directory, so `/usr/local/share/fonts` alone was not discovered in the validation image with workdir `/app`. The [upstream implementation](https://github.com/Brooooooklyn/canvas/blob/main/src/global_fonts.rs) describes the native scan. Both destinations are supported by Bunko, but renderer discovery rules still apply.

Resvg exposes `font.loadSystemFonts`, `font.fontFiles` and `font.fontDirs`; see its [API](https://github.com/thx/resvg-js/blob/main/index.d.ts). In the pinned slim base, Resvg 2.6.2 loaded no fonts with `loadSystemFonts: true` alone because its fontdb build reads fontconfig directories and the base has no fontconfig configuration. Set `fontDirs: ["/usr/share/fonts"]` to scan every vendored face without maintaining a per-file registration list. Alternatively, preserve automatic system scanning by packaging the following ordinary application asset and setting `bunko.env.FONTCONFIG_FILE` to `/app/fonts.conf` (adjust for a custom workdir):

```xml
<?xml version="1.0"?>
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
</fontconfig>
```

Include `fonts.conf` in `bunko.assets`. This stays under the application workdir; it does not replace `/etc/fonts` or use the font destination exception. The fixture demonstrates both this configuration and direct `fontDirs` scanning. Fontconfig-based consumers may additionally need native fontconfig libraries in the base; Bunko does not add those.

Canvas 1.0.5 discovered both faces automatically, but selecting only the CJK family did not produce colored emoji in the probe. Set a family stack such as `40px "Noto Sans CJK JP", "Noto Color Emoji"`, or select the emoji face explicitly. Placement makes fonts available; it does not override renderer family/fallback policy.

For applications with a fixed face list, ordinary workdir assets and explicit registration remain supported:

```js
import { GlobalFonts } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';

GlobalFonts.registerFromPath('/app/fonts/NotoSansCJKjp-Regular.otf');
const renderer = new Resvg(svg, {
  font: {
    loadSystemFonts: false,
    fontFiles: ['/app/fonts/NotoSansCJKjp-Regular.otf'],
  },
});
```

Font discovery and glyph fallback are separate from support for color font formats. Noto Color Emoji uses CBDT/CBLC bitmap tables; a renderer that only supports outlines can still lack color emoji after correctly finding that file. Consult the renderer's supported formats rather than treating successful image creation as proof of correct glyphs.

## Licenses and validation

The validation runner downloads Noto Sans CJK JP and Noto Color Emoji from exact upstream commits, checks SHA-256 digests, and packages their accompanying OFL 1.1 license files. The font licenses are in [Noto CJK Sans](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE) and [Noto Emoji fonts](https://github.com/googlefonts/noto-emoji/blob/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/LICENSE). The Noto Emoji repository's general Apache license applies to other material; select the license accompanying the actual font files. No font binaries are vendored into Bunko itself.

Run `bun run build && bun run test:fonts` with Docker and network access. The fixture uses `@napi-rs/canvas` 1.0.5 and `@resvg/resvg-js` 2.6.2 on a digest-pinned Bun 1.3.13 slim base. It compares automatic discovery with explicit registration, checks Canvas CJK and colored emoji pixels including an explicit CJK/emoji font-family stack, and checks Resvg CJK output with an application fontconfig file and directory scanning against a no-font negative control. Resvg color emoji rendering is not certified by this fixture. Containers run with UID 65532, a read-only filesystem, networking disabled and no font-cache generation.

On 2026-09-08, both Linux amd64 and arm64 passed this fixture with the same rendered pixel digests on each architecture:

| Render | SHA-256 of RGBA pixels |
| --- | --- |
| Canvas CJK | `6269c0ee6b509b01f1dfb88b19c18f634e352c5f05442929a4fe59570a7759f0` |
| Canvas color emoji | `1e53ab472987dd22d2b5acab7553ba85ec8179cce205ce76b2ad0cb376c74f85` |
| Resvg CJK | `8a0089873912bd1e87165443608664211d5a2af476f915a8da861f21ac30dad2` |

These values identify this fixture and pinned inputs, not a cross-version rendering guarantee. CI repeats the amd64 runtime probe. Unit tests separately cover malformed font data, collection bounds, reserved destinations, executable modes, source/base symlinks, notices, deterministic layers and cache invalidation.
