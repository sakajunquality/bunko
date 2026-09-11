# Base image capabilities

Version 0.4.0 adds a static filesystem capability report to `check-base` and `images[].baseCapabilities` in build reports. It resolves the selected manifest per platform and inspects verified layer metadata, including whiteouts and image-local symlinks. It never follows image links onto the host filesystem. Static `check-base` downloads and decodes all selected base layers, even without `--run`; use a local base layout to avoid repeated registry reads.

```sh
bunko check-base --base oven/bun:1.4.2-slim --platform linux/amd64,linux/arm64
bunko check-base --base oven/bun:1.4.2-distroless --platform linux/amd64 \
  --requirements-report ./image-report.json
```

`--requirements-report` accepts an existing single-target, multi-target or resolve build report. Native requirements are selected by Linux architecture; a report missing a requested architecture is rejected. Names and paths are validated before registry reads. Files larger than 16 MiB are refused. Build commands automatically compare each platform's own `native[].needed` values with its base, including on dependency-cache hits.

| Field | Meaning |
| --- | --- |
| `ca` | Common nonempty CA files, directories with candidate certificates, and configured `SSL_CERT_FILE` / `SSL_CERT_DIR`. Contents, selected roots and client-specific trust rules are not validated. |
| `fonts` | Candidate font count, up to 100 paths, a truncation indicator, and common fontconfig paths. Family and glyph availability require renderer execution. |
| `shells` | Common shell paths resolving to executable regular files. |
| `user`, `workdir` | Base-declared user and inspected workdir state; build reports inspect the application's selected workdir. |
| `sharedLibraries` | Nonempty regular-file candidates grouped by library basename, capped at 1,000 names and 100 paths per name with counts/truncation indicators. Requirement matching uses the complete inventory. |
| `inactiveNativeVariants` | Opposite-libc addon variants with a matching alternative; includes the addon path, libc, inferred base libc and alternative path. Files remain packaged. |
| `requirements`, `missingFromBase` | Required library, native file requiring it, candidate paths and a static status. Relative loader paths and cyclic/unresolvable links are `unknown`. `unresolvedPaths` records paths whose links could not be inspected. |

Build logs emit `BUNKO_MISSING_BASE_LIBRARY` with the missing name and requiring file. This is an advisory, not proof that the final application cannot load: application layers may provide a library. Likewise, presence does not establish loader search paths, architecture, symbol versions or ABI compatibility. `runtimeCompatibilityVerified` stays false. `check-base --run` separately tests Bun's exact revision under Docker; it does not execute all native addons.

Paired Linux addon variants are marked `inactive-libc-variant` in `requirements` and excluded from `missingFromBase` and warning logs when the base has only one recognized executable libc loader for that architecture. Selection requires matching ELF libc dependencies and corresponding variant-labelled paths (including the same package version when present); names alone are insufficient. An unpaired variant, unknown or mixed loader base, conflicting ELF evidence, or unrelated alternative retains the usual advisory. This is a static advisory policy for conventional runtime-selected variants, not proof of which file application code loads. Both variants and their complete requirements remain in the report and image.

Missing fonts, CA stores or a shell are reported as capabilities, not errors. Applications that use only Bun TLS or direct executable entrypoints may not need them. See the [cookbook](COOKBOOK.md#choose-a-base-without-runtime-surprises), [fonts](FONTS.md), and [CA configuration](CONFIGURATION.md#application-ca-certificates).
