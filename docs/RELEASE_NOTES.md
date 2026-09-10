# v0.3.0

Bunko adds independent registry and local cache imports and exports. Use ordered `--cache-from type=registry,repo=...` / `type=local,src=...` and repeated `--cache-to type=registry,repo=...` / `type=local,dest=...`. Bare repository values and `--cache-repo` remain supported. Explicit exports also work with `--push=false`; typed write destinations replace implicit image-repository cache writes while preserving reads and supplementing an explicit `--cache-repo` or `BUNKO_CACHE_REPO`.

Registry exports reconcile concurrent immutable-tag races only after verifying matching metadata, compressed layer digest and DiffID. Reports include per-destination outcomes, failure reasons, bytes and duration. Export errors warn by default; `--cache-export-error=fail` collects outcomes and then fails without hiding an already-published image. OpenTelemetry adds bounded cache export metrics.

Local exports use Bunko's managed cache format with locked, atomic writes. Imported layers retain the same validation and compatibility checks as registry layers. Canonical cache locations are excluded from source snapshots, and unsafe overlaps are rejected. The build Action forwards typed cache locations and the export error policy. `--cache-write=false` suppresses configured exports while retaining reads and ordinary local persistence.

Dry-run and offline builds skip explicit exports; strict export mode rejects these combinations. Offline local imports are supported. GHA and S3 backends are not included, and Bunko cache artifacts are not BuildKit cache artifacts. Cache writers must be trusted. Provider immutability and cleanup policies remain under operator control.

Bun support remains stable Bun >=1.3.13 <1.5. See [cache distribution and retention](https://github.com/sakajunquality/bunko/blob/main/docs/CACHE_RETENTION.md) and the [0.3.0 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.3.0.md). External application-machine acceptance and live private ECR/Artifact Registry immutability behavior remain unverified.
