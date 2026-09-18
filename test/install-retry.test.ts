import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installConcurrency, readBunfig } from "../packages/bunko/bunfig.ts";
import { dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { transientInstallFailure } from "../packages/bunko/install-retry.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { runAbortScope } from "../packages/runtime/invocation.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { temporary } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const transport = "error: failed to download fixture-msg@1.0.0: ConnectionRefused";

test("only recognized transient download failures are retried", () => {
  for (const line of [transport, "error: failed to download x@1: 503 Service Unavailable", "error: failed to download x@1: HTTP 5xx", "error: GET https://registry.example/x - 429", "error: failed to download x@1: ECONNRESET"]) {
    expect(transientInstallFailure("", line)).toBe(true);
    for (const permanent of ["error: GET https://registry.example/y - 401", "error: GET https://registry.example/y - 403", "error: GET https://registry.example/y - 404", "error: integrity check failed", "error: lockfile changed", "error: unrelated failure"]) expect(transientInstallFailure(permanent, line)).toBe(false);
  }
  for (const line of ["", "ConnectionRefused", "error: package ConnectionRefused missing", "error: failed to download x@1: certificate error", "error: failed to download x@1: 404 Not Found", "error: failed to download x@1: HTTP 4xx"]) expect(transientInstallFailure("", line)).toBe(false);
});

test("project install concurrency is validated and overrides the environment", async () => {
  const root = await temporary(); roots.push(root);
  await writeFile(join(root, "bunfig.toml"), "[install]\nnetworkConcurrency = 4\n");
  expect(await readBunfig(root)).toEqual({ networkConcurrency: 4 });
  expect(installConcurrency(await readBunfig(root), { BUN_CONFIG_NETWORK_CONCURRENCY: "8" })).toBe(4);
  expect(installConcurrency({}, { BUN_CONFIG_NETWORK_CONCURRENCY: "8" })).toBe(8);
  expect(installConcurrency({}, {})).toBeUndefined();
  for (const value of [0, -1, 1.5, 65536, "secret-value"]) {
    await writeFile(join(root, "bunfig.toml"), `[install]\nnetworkConcurrency = ${JSON.stringify(value)}\n`);
    await expect(readBunfig(root)).rejects.toThrow("install.networkConcurrency must be an integer");
  }
  for (const value of ["", "0", "-1", "1.5", "65536", "secret-value"]) expect(() => installConcurrency({}, { BUN_CONFIG_NETWORK_CONCURRENCY: value })).toThrow("BUN_CONFIG_NETWORK_CONCURRENCY must be an integer");
});

async function fixture(outputs: string[], extra = "") {
  const root = await temporary(); roots.push(root);
  const f = await dependencyFixture(root);
  const plan = await dependencyPlan(await loadProject({ path: f.source }), f.source);
  plan.installPolicy = { networkConcurrency: 4 };
  plan.npmrc = "//registry.npmjs.org/:_authToken=private-test-secret\n";
  const count = join(root, "attempts.json"), fake = join(root, "fake-bun");
  await writeFile(fake, `#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';
const file=${JSON.stringify(count)};
const attempts=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
attempts.push(process.argv.slice(2));writeFileSync(file,JSON.stringify(attempts));
${extra}
const output=${JSON.stringify(outputs)}[attempts.length-1] ?? '';
if(output){console.error(output);process.exit(1);}
`);
  await chmod(fake, 0o755);
  return { ...f, plan, count, toolchain: { path: fake, version: Bun.version, revision: Bun.revision } };
}

test("host and production installs recover, retaining cache, flags and frozen inputs", async () => {
  for (const target of [undefined, { os: "linux" as const, architecture: "amd64" as const }]) {
    const f = await fixture([transport, ""]);
    await installDependencies(f.source, f.plan, f.toolchain, target, f.cache);
    const attempts = JSON.parse(await readFile(f.count, "utf8")) as string[][];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toContain("--network-concurrency=4");
    expect(attempts[0]).toContain(`--cache-dir=${f.cache}`);
    expect(attempts[0]!.includes("--production")).toBe(!!target);
    expect(await Bun.file(join(f.source, ".npmrc")).exists()).toBe(false);
  }
});

test("retries stop after three attempts and terminal diagnostics remain redacted", async () => {
  const output = `${transport}\nhttps://user:private-test-secret@registry.example/x?token=private-test-secret`;
  const f = await fixture([output, output, output]);
  const failure = await installDependencies(f.source, f.plan, f.toolchain, undefined, f.cache).then(() => "", (error: Error) => error.message);
  expect(JSON.parse(await readFile(f.count, "utf8"))).toHaveLength(3);
  expect(failure).toContain("after 3 attempts");
  expect(failure).toContain("install.networkConcurrency");
  expect(failure).not.toContain("private-test-secret");
  expect(await Bun.file(join(f.source, ".npmrc")).exists()).toBe(false);
});

test("permanent failures and frozen-input mutations stop immediately", async () => {
  for (const [output, extra, message] of [["error: GET https://registry.example/x - 401", "", "exit 1"], [transport, "writeFileSync('bun.lock','changed');", "Frozen install changed bun.lock"]]) {
    const f = await fixture([output!], extra);
    await expect(installDependencies(f.source, f.plan, f.toolchain, undefined, f.cache)).rejects.toThrow(message!);
    expect(JSON.parse(await readFile(f.count, "utf8"))).toHaveLength(1);
  }
});

test("cancellation during backoff prevents another install and cleans credentials", async () => {
  const f = await fixture([transport, transport]);
  await expect(runAbortScope(async (abort) => {
    const pending = installDependencies(f.source, f.plan, f.toolchain, undefined, f.cache);
    const timer = setTimeout(() => abort(new Error("test cancellation")), 500);
    try { await pending; } finally { clearTimeout(timer); }
  })).rejects.toThrow("test cancellation");
  expect(JSON.parse(await readFile(f.count, "utf8"))).toHaveLength(1);
  expect(await Bun.file(join(f.source, ".npmrc")).exists()).toBe(false);
});

test("real Bun installs with reduced concurrency and recovers from a truncated 429 on Bun 1.4", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = await temporary(); roots.push(root);
  const source = join(root, "source"), pkg = join(root, "package"), count = join(root, "count");
  await mkdir(source); await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "retry-fixture", version: "1.0.0", main: "index.js" }));
  await writeFile(join(pkg, "index.js"), 'module.exports="recovered";');
  const archive = join(root, "package.tgz");
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", root, "package"], { stdout: "pipe", stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  const bytes = await readFile(archive), integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  // Bun 1.3 can keep retrying a truncated response without returning control.
  // Exercise its successful real install here; subprocess retry behavior is
  // covered above on both versions, and the reported proxy failure on Bun 1.4.
  const injectFailure = Bun.semver.satisfies(Bun.version, ">=1.4.0");
  let rejected = 0, served = 0;
  const { createServer } = await import("node:http");
  const server = createServer(async (_request, response) => {
    if (injectFailure && await readFile(count, "utf8") === "1") {
      rejected++;
      // Reproduce a proxy that closes a rate-limited download before its body completes.
      response.writeHead(429, { "content-length": "1000", connection: "close" });
      response.flushHeaders(); response.destroy(); return;
    }
    served++; response.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const manifest = { name: "retry-app", dependencies: { "retry-fixture": "1.0.0" } };
    const lock = { lockfileVersion: 1, configVersion: 1, workspaces: { "": manifest }, packages: { "retry-fixture": ["retry-fixture@1.0.0", `${registry}/fixture.tgz`, {}, integrity] } };
    await writeFile(join(source, "package.json"), JSON.stringify(manifest));
    await writeFile(join(source, "bun.lock"), JSON.stringify(lock));
    const wrapper = join(root, "real-bun");
    await writeFile(wrapper, `#!${process.execPath}\nimport {existsSync,readFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(count)};writeFileSync(file,String((existsSync(file)?Number(readFileSync(file,'utf8')):0)+1));
const child=Bun.spawn([${JSON.stringify(process.execPath)},...process.argv.slice(2)],{stdout:'inherit',stderr:'inherit'});
const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const code=await child.exited;clearTimeout(timer);process.exit(code);
`);
    await chmod(wrapper, 0o755);
    await installDependencies(source, { manifest, lock, registry, resolution: {}, patches: {}, installPolicy: { networkConcurrency: 1 } }, { path: wrapper, version: Bun.version, revision: Bun.revision }, { os: "linux", architecture: "amd64" }, join(root, "cache"));
    expect(await readFile(count, "utf8")).toBe(injectFailure ? "2" : "1");
    if (injectFailure) expect(rejected).toBeGreaterThan(0); else expect(rejected).toBe(0); expect(served).toBeGreaterThan(0);
    expect(await readFile(join(source, "node_modules/retry-fixture/index.js"), "utf8")).toContain("recovered");
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}, 30000);
