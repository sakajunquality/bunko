import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Telemetry, telemetryConfig } from "../packages/bunko/telemetry.ts";
import { phase } from "../packages/bunko/progress.ts";
import { baseLayout, project, temporary } from "./helpers.ts";

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of clean.splice(0).reverse()) await dispose(); });
function receiver(respond: (request: Request) => Response | Promise<Response> = () => Response.json({})) {
  const received: { path: string; body: any; headers: Headers }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push({ path: new URL(request.url).pathname, body: await request.json(), headers: request.headers });
    return respond(request);
  } });
  clean.push(() => server.stop(true));
  return { received, endpoint: `http://127.0.0.1:${server.port}` };
}
function spans(received: ReturnType<typeof receiver>["received"]) { return received.find((item) => item.path.endsWith("traces"))!.body.resourceSpans[0].scopeSpans[0].spans as any[]; }
function metrics(received: ReturnType<typeof receiver>["received"]) { return received.find((item) => item.path.endsWith("metrics"))!.body.resourceMetrics[0].scopeMetrics[0].metrics as any[]; }

test("telemetry requires explicit opt-in and validates only its supported configuration", () => {
  expect(telemetryConfig(false, { OTEL_EXPORTER_OTLP_ENDPOINT: "secret invalid" })).toBeUndefined();
  expect(telemetryConfig(true, { OTEL_SDK_DISABLED: "true" })).toBeUndefined();
  const config = telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.test/prefix/", OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20test" })!;
  expect(config.traces!.href).toBe("https://example.test/prefix/v1/traces");
  expect(config.headers.authorization).toBe("Bearer test");
  expect(telemetryConfig(true, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://example.test/custom", OTEL_METRICS_EXPORTER: "none" })!.traces!.pathname).toBe("/custom");
  for (const env of [{ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@example.test" }, { OTEL_EXPORTER_OTLP_TIMEOUT: "Infinity" }, { OTEL_EXPORTER_OTLP_HEADERS: "host=evil" }]) expect(() => telemetryConfig(true, env)).toThrow();
});

test("parallel targets retain parents and export delta histograms without private identities", async () => {
  const r = receiver(); const events: unknown[] = [];
  const session = new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!);
  await session.run("build", () => Promise.all(["private-a", "private-b"].map((target) => phase((e) => { events.push(e); }, "prepare", () => phase(undefined, "assemble", () => phase(undefined, "bundle", async () => { await Bun.sleep(5); }), undefined, "linux/amd64"), target))));
  const all = spans(r.received), ids = new Set(all.map((s) => s.spanId));
  expect(all.filter((s) => s.name === "bunko.target")).toHaveLength(2);
  expect(all.filter((s) => s.name === "bunko.platform")).toHaveLength(2);
  for (const span of all) {
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/); expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    if (span.parentSpanId) expect(ids.has(span.parentSpanId)).toBe(true);
  }
  expect(JSON.stringify(r.received)).not.toContain("private-");
  const histogram = metrics(r.received).find((m) => m.name === "bunko.phase.duration").histogram;
  expect(histogram.aggregationTemporality).toBe(1);
  for (const point of histogram.dataPoints) expect(point.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0)).toBe(Number(point.count));
  expect(events).toHaveLength(12);
});

test("failure is exported without exception content and exporter errors preserve the result", async () => {
  for (const response of [() => new Response("secret", { status: 500 }), () => Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "secret" } }), () => new Response("invalid")]) {
    const r = receiver(response); let warnings = 0;
    const session = new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!, () => { warnings++; });
    const error = new Error("private exception");
    await expect(session.run("build", () => phase(undefined, "bundle", async () => { throw error; }))).rejects.toBe(error);
    expect(warnings).toBe(1); expect(JSON.stringify(r.received)).not.toContain("private exception");
    expect(spans(r.received).find((s) => s.name === "bunko.build").status.code).toBe(2);
  }
});

test("redirects never forward headers and a stalled body has a bounded flush", async () => {
  const destination = receiver();
  const redirect = receiver(() => new Response(null, { status: 307, headers: { Location: `${destination.endpoint}/v1/traces` } }));
  let warnings = 0;
  await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: redirect.endpoint, OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret" })!, () => { warnings++; }).run("build", async () => 42);
  expect(destination.received).toHaveLength(0); expect(warnings).toBe(1);
  const stalled = receiver(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json" } }));
  const start = performance.now();
  expect(await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: stalled.endpoint, OTEL_EXPORTER_OTLP_TIMEOUT: "50" })!).run("build", async () => 7)).toBe(7);
  expect(performance.now() - start).toBeLessThan(1500);
});

test("CLI exports cold/warm builds, preserves image identity, and leaves stdout clean", async () => {
  const r = receiver(), root = await temporary(); clean.push(() => rm(root, { recursive: true, force: true }));
  const base = await baseLayout(join(root, "base")), app = await project(join(root, "app"), { name: "private-workload" });
  const execute = async (extra: string[], n: number) => {
    const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "build", app, "--push=false", "--base-layout", base, "--oci-layout", join(root, `out-${n}`), "--cache-dir", join(root, "cache"), "--git-metadata=false", "--report", join(root, `report-${n}.json`), ...extra], { env: { PATH: process.env.PATH ?? "", HOME: root, OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint, OTEL_SDK_DISABLED: "false", OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stdout).toBe(""); expect(stderr).not.toContain("export incomplete");
    return Bun.file(join(root, `report-${n}.json`)).json();
  };
  const a = await execute([], 0); expect(r.received).toHaveLength(0);
  const b = await execute(["--otel", "--no-cache", "--progress=json"], 1);
  expect(b.root.digest).toBe(a.root.digest); expect(b.timings.some((t: any) => t.phase === "bundle")).toBe(true);
  expect(spans(r.received).some((s) => s.name === "bunko.base-pull")).toBe(true);
  r.received.length = 0;
  await execute(["--otel"], 2);
  expect(spans(r.received).some((s) => s.name === "bunko.bundle")).toBe(false);
  expect(metrics(r.received).some((m) => m.name === "bunko.cache.lookup.count")).toBe(true);
  expect(JSON.stringify(r.received)).not.toContain("private-workload"); expect(JSON.stringify(r.received)).not.toContain(root);
});

test("transient collector failures retry once without duplicating successful signals", async () => {
  const attempts = new Map<string, number>();
  const r = receiver((request) => { const path = new URL(request.url).pathname; const count = (attempts.get(path) ?? 0) + 1; attempts.set(path, count); return count === 1 ? new Response(null, { status: 503 }) : Response.json({}); });
  let warnings = 0;
  await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!, () => { warnings++; }).run("build", async () => {});
  expect([...attempts.values()]).toEqual([2, 2]); expect(warnings).toBe(0);
});

test("span limits preserve retained parents while metrics continue aggregating", async () => {
  const r = receiver(); let warnings = 0;
  const session = new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!, () => { warnings++; });
  await session.run("build", () => phase(undefined, "prepare", async () => {
    for (let i = 0; i < 4100; i++) await phase(undefined, "bundle", async () => {});
  }, "hidden-target"));
  const all = spans(r.received), ids = new Set(all.map((s) => s.spanId));
  expect(all).toHaveLength(4098); expect(warnings).toBe(1);
  for (const span of all) if (span.parentSpanId) expect(ids.has(span.parentSpanId)).toBe(true);
  const histogram = metrics(r.received).find((m) => m.name === "bunko.phase.duration").histogram;
  const bundled = histogram.dataPoints.find((p: any) => p.attributes.some((a: any) => a.value.stringValue === "bundle"));
  expect(bundled.count).toBe("4100");
});

test("oversized collector responses do not alter a successful command", async () => {
  const r = receiver(() => new Response(' '.repeat(70000))); let warnings = 0;
  const result = await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!, () => { warnings++; }).run("build", async () => 0);
  expect(result).toBe(0); expect(warnings).toBe(1);
});

test("CLI build failure exports sanitized failure and keeps JSON progress well formed", async () => {
  const r = receiver(() => new Response(null, { status: 400 })), root = await temporary(); clean.push(() => rm(root, { recursive: true, force: true }));
  const app = await project(join(root, "app"), {}, 'this is invalid typescript @@@');
  const base = await baseLayout(join(root, "base"));
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "build", app, "--otel", "--push=false", "--base-layout", base, "--oci-layout", join(root, "out"), "--no-cache", "--progress=json"], { env: { PATH: process.env.PATH ?? "", HOME: root, OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(1); expect(stdout).toBe("");
  const events = stderr.trim().split('\n').map((line) => JSON.parse(line));
  expect(events.some((e) => e.type === "error")).toBe(true);
  expect(events.filter((e) => e.message?.includes("OpenTelemetry export incomplete"))).toHaveLength(1);
  expect(spans(r.received).find((s) => s.name === "bunko.build").status.code).toBe(2);
  expect(JSON.stringify(r.received)).not.toContain(root);
});


test("identically named targets in different contexts have separate anonymous groups", async () => {
  const r = receiver();
  await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!).run("resolve", async () => {
    for (const key of ["/private/first", "/private/second"]) await phase(undefined, "prepare", () => phase(undefined, "bundle", async () => {}), "same-name", undefined, key);
  });
  expect(spans(r.received).filter((s) => s.name === "bunko.target")).toHaveLength(2);
  expect(JSON.stringify(r.received)).not.toContain("/private");
});

test("Retry-After beyond the deadline is not retried and malformed partial success is rejected", async () => {
  const limited = receiver(() => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
  let warnings = 0;
  await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: limited.endpoint })!, () => { warnings++; }).run("build", async () => 0);
  expect(limited.received).toHaveLength(2); expect(warnings).toBe(1);
  const malformed = receiver(() => Response.json({ partialSuccess: { rejectedSpans: "invalid" } }));
  await new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: malformed.endpoint })!, () => { warnings++; }).run("build", async () => 0);
  expect(warnings).toBe(2);
});

test("a returned nonzero command exit is a failure and a session cannot be reused", async () => {
  const r = receiver(), session = new Telemetry(telemetryConfig(true, { OTEL_EXPORTER_OTLP_ENDPOINT: r.endpoint })!);
  expect(await session.run("apply", async () => 7, (code) => code !== 0)).toBe(7);
  expect(spans(r.received).find((s) => s.name === "bunko.build").status.code).toBe(2);
  await expect(session.run("apply", async () => 0)).rejects.toThrow("only run once");
});
