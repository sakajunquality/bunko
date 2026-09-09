# Build telemetry

Bunko can export build traces and metrics to an OpenTelemetry Collector. This is opt-in with `--otel` on `build`, `resolve` and `apply`. No telemetry is sent by default, even if the environment contains OpenTelemetry settings. The image and cache keys do not include telemetry configuration or timings.

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  bunko build . --otel --repo registry.example.com/team
```

The initial implementation uses [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/), without an SDK dependency or automatic instrumentation. It sends one bounded batch per signal at invocation completion. `apply` includes document resolution and kubectl execution in the invocation outcome; a nonzero kubectl exit counts as failure. Invalid CLI arguments before execution do not produce a build trace. Abrupt process termination can lose pending telemetry.

## Configuration

| Setting | Behavior |
| --- | --- |
| `--otel` / `--otel=false` | Explicitly enable/disable telemetry for this invocation |
| `OTEL_SDK_DISABLED=true` | Disable even when `--otel` is present |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; default `http://127.0.0.1:4318`; append `/v1/traces` and `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Exact per-signal URL, without automatic path suffix |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp` (default) or `none` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` and signal-specific protocol settings | Only `http/json` is supported; this is Bunko's default |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `name=value` headers with percent-encoded values; keep credentials in the environment |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Total flush deadline across both concurrent exports, 1–10000 milliseconds; default 2000 |

Empty environment values are treated as unset. Setting both signal exporters to `none` disables telemetry.

This is a deliberately limited configuration surface, not full OpenTelemetry SDK environment compatibility. Resource detection, resource environment attributes, service-name overrides, propagation/baggage, sampling, per-signal headers/timeouts, gRPC, protobuf, TLS client certificates, logs, CPU and memory metrics are not implemented. Use a local Collector to handle backend authentication, buffering and protocol conversion. HTTP is supported without exporter headers for local Collectors; use HTTPS for remote endpoints. Configuring any exporter header requires HTTPS for every enabled signal, including loopback and signal-specific endpoints.

Invalid supported settings fail before the build starts. URLs cannot contain embedded credentials, query strings or fragments. Exports never follow redirects or reuse registry credentials. Export failure or partial rejection emits one fixed warning on stderr, with JSON framing under `--progress=json`; it never changes the build result or stdout. Connection failures and HTTP 429/502/503/504 receive at most one retry after at least 100 ms within the same deadline, honoring Retry-After when supplied. A retried request can be delivered twice if the previous acknowledgement was lost. Other errors, malformed responses and partial rejection are not retried. Delivery is best effort within the flush deadline, not durable storage.

## Signals

Resource attributes are fixed to `service.name=bunko` and the CLI `service.version`. Traces contain a `bunko.build` root and anonymous target/platform grouping spans. Stage spans share the same boundaries as JSON progress events. Progress schema version 1 is extended additively with new phase names and an optional platform field; consumers should tolerate unknown phases/fields. Target numbers are invocation-local and are not metric attributes. Raw target names remain available in existing local progress output but are not exported to the Collector.

Stages include snapshot, prepare, base-resolve, base-inspect, base-pull, runtime, assemble, install, bundle, pack, publish and push. `base-resolve` reads base manifests/configs; `base-inspect` verifies and decodes layer filesystems, including its nested `base-pull` work. `base-pull` covers layer materialization through digest verification, including local-layout reads. A reused verified filesystem emits no second inspection duration. A shared base blob is attributed to the first selected platform owning it. `runtime` covers signed release download/cache verification; runtime layer construction is included in assemble. `assemble` includes its nested install/bundle/pack work; do not sum parent and child durations. Shared bundle work is recorded once, on the platform that performs it. Skipped stages on cache hits emit no duration. Target/platform grouping spans cover their observed work, including gaps between preparation and publication.

| Metric | Instrument / unit | Attributes |
| --- | --- | --- |
| `bunko.build.count` | Monotonic sum / `{build}` | command, result |
| `bunko.build.duration` | Histogram / `s` | command, result |
| `bunko.phase.duration` | Histogram / `s` | phase, platform when known, result |
| `bunko.cache.lookup.count` | Monotonic sum / `{lookup}` | cache kind, cache result |
| `bunko.base.read.bytes` | Monotonic sum / `By` | source: layout or registry |
| `bunko.image.transfer.bytes` | Monotonic sum / `By` | transfer action |

Attribute keys use the `bunko.` prefix. Cache results are local, registry, miss or bypass. Transfer actions are uploaded, reused, mounted or would-upload. Uploaded values count acknowledged image-publication payload bytes (including attached SBOM/provenance payloads); other actions count logical descriptor sizes. They are not network wire-byte counters and exclude retransmissions, failed unacknowledged uploads, registry cache publication and manifest requests. Dry-run estimates use would-upload, never uploaded. Failed publication exports whatever transfer evidence is available in the existing publication report.

All metric exports use delta temporality. Duration histogram bounds in seconds are 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60 and 300, plus the overflow bucket. The Collector can aggregate successive CLI invocations for dashboards.

The exporter never adds project paths, package/image names, registry URLs, digests, Git metadata, configuration values, environment values or exception messages to signals. Counters and spans are explicitly instrumented; there is no network auto-instrumentation. An invocation retains at most 4096 stage spans, 256 grouping spans and 512 metric series. Overflow is reported as an incomplete export. Metrics continue aggregating existing series after the span limit. Responses are limited to 64 KiB.

Build reports include a bounded `timings` array for stages within target preparation/publication. This is a local report, not an OTLP payload: existing report fields can contain project identities. Outer invocation/snapshot/prepare/publish timings are available in progress and telemetry, not this per-target array. Timings are observational and do not participate in deterministic image comparisons.

## Local Collector example

The checked-in [Collector configuration](../examples/telemetry/collector.yaml) exports both signals to its debug log. Start it with loopback-only port publication:

```sh
docker run --rm --name bunko-collector \
  -p 127.0.0.1:4318:4318 \
  --mount "type=bind,src=$PWD/examples/telemetry/collector.yaml,dst=/etc/otelcol-contrib/config.yaml,readonly" \
  otel/opentelemetry-collector-contrib@sha256:85ac41c2db88d0df9bd6145e608a3cb023f5d8443868adbfbbf66efb51087917
```

The pinned Collector version is 0.120.0, used for protocol interoperability testing. Replace its debug exporter with your own backend exporter for deployment. Bunko does not deploy or configure that backend.

Run `bun run build && bun run test:telemetry` for the distributed-CLI/real-Collector smoke test. Ordinary unit tests also cover opt-in, privacy, cache behavior, concurrent contexts, failure preservation, redirects and stalled response bodies.
