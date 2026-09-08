import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baseLayout, project } from "../../test/helpers.ts";

const image = "otel/opentelemetry-collector-contrib@sha256:85ac41c2db88d0df9bd6145e608a3cb023f5d8443868adbfbbf66efb51087917";
const root = await mkdtemp(join(tmpdir(), "bunko-otel-"));
const name = `bunko-otel-${crypto.randomUUID()}`;
async function run(args: string[], env = process.env) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`Validation command failed (${args[0]}): ${stderr}`);
  return stdout + stderr;
}
try {
  await run(["docker", "run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::4318", "--mount", `type=bind,src=${resolve("examples/telemetry/collector.yaml")},dst=/etc/otelcol-contrib/config.yaml,readonly`, image]);
  const address = (await run(["docker", "port", name, "4318/tcp"])).trim();
  const endpoint = `http://${address}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(`${endpoint}/v1/traces`, { signal: AbortSignal.timeout(500) }); await response.body?.cancel(); ready = true; break; } catch { await Bun.sleep(250); }
  }
  if (!ready) throw new Error("Collector did not become ready");
  const base = await baseLayout(join(root, "base")), app = await project(join(root, "app"));
  const output = await run([process.execPath, resolve("dist/bunko.js"), "build", app, "--otel", "--push=false", "--base-layout", base, "--oci-layout", join(root, "image"), "--no-cache", "--git-metadata=false"], { PATH: process.env.PATH ?? "", HOME: root, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
  if (output.includes("OpenTelemetry export incomplete")) throw new Error("Collector rejected telemetry");
  let accepted = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const logs = await run(["docker", "logs", name]);
    if (["bunko.build.duration", "bunko.cache.lookup.count", "bunko.base.read.bytes", "bunko.bundle"].every((value) => logs.includes(value))) { accepted = true; break; }
    await Bun.sleep(250);
  }
  if (!accepted) throw new Error("Collector did not export both signals");
  console.log(JSON.stringify({ status: "passed", distributedCLI: true, collector: "0.120.0", traces: true, metrics: true }));
} finally {
  await run(["docker", "rm", "-f", name]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
