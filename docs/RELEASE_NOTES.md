# v0.7.0

Build Alpine images with explicit `runtime.libc: "musl"` or `--runtime-libc musl`. Bundle, source and compile modes support Linux amd64 and arm64. The default musl base is the version-matched Bun Alpine image; glibc remains the default libc.

Runtime injection and compilation use official, signed and pinned musl assets for Bun 1.3.13, 1.4.0, 1.4.1 and 1.4.2. Preflight validates the selected loader and searches for required musl libraries in the effective library paths. Compile mode now rejects a missing glibc loader too. Active glibc-only native addons fail musl builds; valid paired optional variants remain available. Libc participates in dependency cache identity, shared-closure validation, diagnostics and provenance parameters.

Inspection cache v3 preserves bounded musl search configuration and rejects inconsistent replay metadata. Existing inspection records are re-inspected. Native library ABI and transitive requirements still require application testing; bunko does not install OS packages. Bare Alpine generally needs libstdc++ before signed runtime injection.

Bun host support remains >=1.3.13 <1.5. See the [Alpine guide](https://github.com/sakajunquality/bunko/blob/main/docs/MUSL.md) and [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.7.0.md). The independently versioned setup-bunko v0.1.0 Action retains CLI v0.6.2 as its default; pass `version: v0.7.0` to select this release.
