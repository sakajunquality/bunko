# v0.8.1

This patch adds a dedicated [compile guide](https://github.com/sakajunquality/bunko/blob/v0.8.1/docs/COMPILE.md) and runnable single-binary example, including separately packaged runtime assets and explicit Bun feature limitations. Compile smoke tests now verify those asset reads.

Completed-image acceptance now checks actual runtime behavior alongside image structure on native Linux amd64 and arm64. Cases cover lazy workspace dependencies, source-mode module-relative catalog access, and negative controls where startup alone would miss a broken application. Linux CI also exercises cross-device cache operations using different filesystems.

There are no CLI implementation changes since v0.8.0. Runtime support and rebase compatibility boundaries are unchanged. The additional tests validate their fixtures; they do not certify arbitrary applications or OS-library upgrades.

The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0; use `version: v0.8.1` to select this release. See the [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.8.1.md).
