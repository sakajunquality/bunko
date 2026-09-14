# Cross-device cache acceptance

Run `bun run build && bun run test:cross-device` on Linux with Python 3 and a writable `/dev/shm` mounted separately from the temporary work directory. `BUNKO_CROSS_DEVICE_CACHE_ROOT` can select another existing cache mount. The runner compares actual device IDs and fails if they match or if the mount is unavailable. It does not skip unsupported environments.

The `cross-device` CI job runs the bundled CLI against a disposable loopback registry and a local synthetic base. It maps both a single executable file and a directory tree from a donor image. Build scratch and output live on the work filesystem; the persistent external-asset cache lives on the other filesystem. This exercises real cross-device movement, including the case where a cache under HOME is mounted separately from build scratch, without requiring a production registry or Docker.

Two builds use independent layer caches and the same external-asset cache, so a warm application-layer hit cannot conceal asset-cache behavior. Acceptance requires:

1. A cold CLI build that fetches donor layer bytes and completes successfully.
2. A warm CLI build that fetches no donor layer bytes.
3. Equal output image manifest digests for both builds.
4. Independent Python tarfile inspection of the output assets: exact content, executable mode 0755, and data-file mode 0644.

The same CI job runs the existing asset move and external asset regression tests, including failure cleanup. Ordinary unit tests remain portable and can skip cross-device cases where their required environment is unavailable; the dedicated CLI acceptance gate must pass first.

This checks image-asset caching across mounts. It does not execute the synthetic image or claim coverage of every filesystem type, mount option, quota, or concurrent-cache failure. An optional `BUNKO_SMOKE_REPORT` path records successful results and the measured device IDs; a failing command exits nonzero.
