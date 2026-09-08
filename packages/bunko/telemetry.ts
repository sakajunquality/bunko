import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import metadata from "../../package.json";

export type Attributes = Record<string, string>;
interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: ReturnType<typeof attributes>; status: { code: number } }
interface Context { session: Telemetry; parent: string; target?: string; platform?: string }
const context = new AsyncLocalStorage<Context>();
const attributes = (values: Attributes) => Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
const id = (bytes: number) => randomBytes(bytes).toString("hex");
const bounds = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300];
interface Series { name: string; unit: string; attributes: Attributes; sum: number; count: number; buckets?: number[] }
export interface TelemetryConfig { traces?: URL; metrics?: URL; headers: Record<string, string>; timeout: number }

/** An explicit Bunko opt-in is required even when standard OTel variables exist. */
export function telemetryConfig(enabled: boolean | undefined, env: Record<string, string | undefined> = process.env): TelemetryConfig | undefined {
  if (!enabled || env.OTEL_SDK_DISABLED?.toLowerCase() === "true") return;
  env = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const headers: Record<string, string> = {};
  try {
    for (const entry of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").filter(Boolean)) {
      const equal = entry.indexOf("=");
      if (equal < 1) throw new Error();
      const name = entry.slice(0, equal).trim().toLowerCase(), value = decodeURIComponent(entry.slice(equal + 1).trim());
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value) || ["host", "content-type", "content-length", "connection", "transfer-encoding"].includes(name)) throw new Error();
      headers[name] = value;
    }
    new Headers(headers);
  } catch { throw new Error("Invalid OTEL_EXPORTER_OTLP_HEADERS"); }
  const timeout = Number(env.OTEL_EXPORTER_OTLP_TIMEOUT ?? "2000");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) throw new Error("OTEL_EXPORTER_OTLP_TIMEOUT must be 1–10000 milliseconds");
  const endpoint = (signal: "TRACES" | "METRICS") => {
    const exporter = env[`OTEL_${signal}_EXPORTER`] ?? "otlp";
    if (exporter === "none") return;
    if (exporter !== "otlp") throw new Error(`OTEL_${signal}_EXPORTER must be otlp or none`);
    if ((env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/json") !== "http/json") throw new Error("Bunko telemetry supports only OTLP http/json");
    let url: URL;
    try {
      const specific = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`];
      url = new URL(specific ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318");
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      if (!specific) url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/${signal.toLowerCase()}`;
    } catch { throw new Error(`Invalid OTLP ${signal.toLowerCase()} endpoint`); }
    if (url.protocol === "http:" && Object.keys(headers).length) throw new Error("OTLP exporter headers require HTTPS endpoints");
    return url;
  };
  const traces = endpoint("TRACES"), metrics = endpoint("METRICS");
  return traces || metrics ? { traces, metrics, headers, timeout } : undefined;
}

/** A bounded, invocation-local OTLP/HTTP JSON exporter; no global SDK or resource detection. */
export class Telemetry {
  private traceId = id(16);
  private root = id(8);
  private wall = BigInt(Date.now()) * 1000000n;
  private start = performance.now();
  private spans: Span[] = [];
  private series = new Map<string, Series>();
  private groups = new Map<string, Span>();
  private targets = new Map<string, string>();
  private dropped = 0;
  private ended = false;
  private running = false;
  private timestamp() { return (this.wall + BigInt(Math.round((performance.now() - this.start) * 1e6))).toString(); }
  constructor(private config: TelemetryConfig, private warn: () => void = () => {}) {}
  private span(name: string, parentSpanId?: string, values: Attributes = {}): Span {
    const now = this.timestamp();
    return { traceId: this.traceId, spanId: id(8), parentSpanId, name, kind: 1, startTimeUnixNano: now, endTimeUnixNano: now, attributes: attributes(values), status: { code: 0 } };
  }
  private group(key: string, name: string, parent: string, values: Attributes): string {
    let span = this.groups.get(key);
    if (!span) {
      if (this.groups.size >= 256) { this.dropped++; return parent; }
      span = this.span(name, parent, values); this.groups.set(key, span);
    }
    return span.spanId;
  }
  async phase<T>(name: string, task: () => Promise<T>, target?: string, platform?: string): Promise<T> {
    const current = context.getStore()!;
    target ??= current.target; platform ??= current.platform;
    let parent = current.parent;
    if (target !== current.target || platform !== current.platform) {
      parent = this.root;
      if (target) {
        if (!this.targets.has(target) && this.targets.size < 128) this.targets.set(target, String(this.targets.size));
        const ordinal = this.targets.get(target) ?? "overflow";
        parent = this.group(`target:${ordinal}`, "bunko.target", parent, { "bunko.target.index": ordinal });
        if (platform) parent = this.group(`target:${ordinal}:${platform}`, "bunko.platform", parent, { "bunko.platform": platform });
      }
    }
    const values = { "bunko.phase": name, ...(platform ? { "bunko.platform": platform } : {}) };
    const span = this.span(`bunko.${name}`, parent, values), start = performance.now();
    const retained = this.spans.length < 4096;
    if (retained) this.spans.push(span); else this.dropped++;
    let result = "success";
    try { return await context.run({ session: this, parent: retained ? span.spanId : parent, target, platform }, task); }
    catch (error) { result = "failure"; span.status.code = 2; throw error; }
    finally {
      span.endTimeUnixNano = this.timestamp();
      const ordinal = target ? this.targets.get(target) ?? "overflow" : undefined;
      for (const key of ordinal === undefined ? [] : [`target:${ordinal}`, `target:${ordinal}:${platform}`]) {
        const group = this.groups.get(key); if (group) group.endTimeUnixNano = span.endTimeUnixNano;
      }
      this.record("bunko.phase.duration", "s", (performance.now() - start) / 1000, { ...values, "bunko.result": result }, true);
    }
  }
  record(name: string, unit: string, value: number, values: Attributes, histogram = false) {
    if (!Number.isFinite(value) || value < 0) return;
    const key = JSON.stringify([name, Object.entries(values).sort()]);
    let series = this.series.get(key);
    if (!series) {
      if (this.series.size >= 512) { this.dropped++; return; }
      series = { name, unit, attributes: values, sum: 0, count: 0, buckets: histogram ? Array(bounds.length + 1).fill(0) : undefined }; this.series.set(key, series);
    }
    series.sum += value; series.count++;
    if (series.buckets) { const index = bounds.findIndex((bound) => value <= bound); series.buckets[index < 0 ? bounds.length : index]!++; }
  }
  async run<T>(command: string, task: () => Promise<T>, failed: (value: T) => boolean = () => false): Promise<T> {
    if (this.running) throw new Error("Telemetry invocation may only run once");
    this.running = true;
    let result = "success";
    try { const value = await context.run({ session: this, parent: this.root }, task); if (failed(value)) result = "failure"; return value; }
    catch (error) { result = "failure"; throw error; }
    finally {
      const end = this.timestamp();
      for (const span of this.groups.values()) this.spans.push(span);
      this.spans.push({ ...this.span("bunko.build"), spanId: this.root, startTimeUnixNano: this.wall.toString(), endTimeUnixNano: end, attributes: attributes({ "bunko.command": command }), status: { code: result === "failure" ? 2 : 1 } });
      this.record("bunko.build.count", "{build}", 1, { "bunko.command": command, "bunko.result": result });
      this.record("bunko.build.duration", "s", (performance.now() - this.start) / 1000, { "bunko.command": command, "bunko.result": result }, true);
      await this.flush();
    }
  }
  private async flush() {
    if (this.ended) return; this.ended = true;
    const resource = { attributes: attributes({ "service.name": "bunko", "service.version": metadata.version }) }, scope = { name: "bunko", version: metadata.version };
    const timeUnixNano = this.timestamp(), metrics = new Map<string, Record<string, unknown>>();
    for (const s of this.series.values()) {
      let metric = metrics.get(s.name);
      const type = s.buckets ? "histogram" : "sum";
      if (!metric) { metric = { name: s.name, unit: s.unit, [type]: { aggregationTemporality: 1, ...(s.buckets ? {} : { isMonotonic: true }), dataPoints: [] } }; metrics.set(s.name, metric); }
      const data = metric[type] as { dataPoints: unknown[] };
      data.dataPoints.push({ attributes: attributes(s.attributes), startTimeUnixNano: this.wall.toString(), timeUnixNano,
        ...(s.buckets ? { count: String(s.count), sum: s.sum, explicitBounds: bounds, bucketCounts: s.buckets.map(String) } : { asDouble: s.sum }) });
    }
    const payloads = [
      [this.config.traces, { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: this.spans }] }] }],
      [this.config.metrics, { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [...metrics.values()] }] }] }],
    ] as const;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.config.timeout);
    let failure = this.dropped > 0;
    try {
      await Promise.all(payloads.map(async ([url, payload]) => {
        if (!url) return;
        try {
          const body = JSON.stringify(payload);
          const post = async () => {
            for (let attempt = 0; ; attempt++) {
              let response: Response | undefined;
              try { response = await fetch(url, { method: "POST", headers: { ...this.config.headers, "content-type": "application/json" }, body, redirect: "manual", signal: controller.signal }); }
              catch { if (attempt || controller.signal.aborted) throw new Error(); }
              if (response && ![429, 502, 503, 504].includes(response.status)) return response;
              const retryAfter = response?.headers.get("retry-after");
              let backoff = 100;
              if (retryAfter) {
                const requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
                if (Number.isFinite(requested)) backoff = Math.max(backoff, requested);
              }
              if (response) await response.body?.cancel();
              if (attempt || backoff >= this.config.timeout) throw new Error();
              await delay(backoff, undefined, { signal: controller.signal });
            }
          };
          const response = await post();
          if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(); }
          const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
          try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw new Error(); chunks.push(value); } }
          finally { await reader.cancel(); }
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
          if (result.partialSuccess !== undefined) {
            const partial = result.partialSuccess;
            if (!partial || typeof partial !== "object" || Array.isArray(partial)) throw new Error();
            const rejected = partial.rejectedSpans ?? partial.rejectedDataPoints ?? 0;
            if (!/^[0-9]+$/.test(String(rejected)) || !Number.isSafeInteger(Number(rejected)) || partial.errorMessage !== undefined && typeof partial.errorMessage !== "string") throw new Error();
            if (Number(rejected) > 0 || partial.errorMessage) failure = true;
          }
        } catch { failure = true; }
      }));
    } catch { failure = true; }
    finally { controller.abort(); clearTimeout(timer); if (failure) { try { this.warn(); } catch { /* Telemetry must not replace the build result. */ } } }
  }
}

export function measured<T>(name: string, task: () => Promise<T>, target?: string, platform?: string): Promise<T> {
  const active = context.getStore();
  return active ? active.session.phase(name, task, target, platform) : task();
}
export function metric(name: string, unit: string, value: number, values: Attributes) { context.getStore()?.session.record(name, unit, value, values); }
