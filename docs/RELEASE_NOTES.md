# v0.4.0

Registry cache writes now require an explicit destination: `--cache-repo`, `BUNKO_CACHE_REPO`, or `--cache-to`. Plain publication still reads legacy image-repository cache entries but creates no new cache tags. Existing strict cache-export jobs must select a destination. Managed local caching is unchanged. See [cache migration and retention](https://github.com/sakajunquality/bunko/blob/main/docs/CACHE_RETENTION.md).

Build logs show each platform's complete stored layer size, including the base, with a layer-kind breakdown. Docker archive/local filesystem sizes use expanded bytes and are not directly comparable.

`check-base` and build reports include static CA, font/fontconfig, shell, user/workdir and shared-library evidence. Builds cross-check native requirements and name missing base libraries; `check-base --requirements-report FILE` compares a saved build with another base. These are advisory filesystem checks, not proof of runtime, loader or ABI compatibility. Static registry-base inspection downloads and decodes layers.

`check-config --deep` and `doctor --deep` validate current selected local assets, entrypoints and font bytes without installing dependencies, bundling or contacting registries. Explicit credential/internal asset selections now fail instead of being silently omitted in bundle mode. Invocation-specific output/cache exclusions and runtime collisions remain full-build checks.

`deps.acknowledgedImports` allows individually reviewed undeclared-import findings to be acknowledged while retaining `error` or `strict` for other findings. Optional version pins require exact SemVer. Acknowledgements apply to cached closure findings too; shared closures combine their targets' lists. They do not install missing dependencies or establish runtime safety.

The new [cookbook](https://github.com/sakajunquality/bunko/blob/main/docs/COOKBOOK.md) covers frontend output, fonts, image/URL assets, registry credentials, multiple workloads, native CA trust and base choice. Bun support remains >=1.3.13 <1.5. See [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.4.0.md).
