import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SyntaxCache } from "../packages/bunko/syntax-cache.ts";
import { mapJobs } from "../packages/bunko/concurrency.ts";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { cacheKey, packFormat } from "../packages/bunko/cache.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
import { MockRegistry } from "./mock-registry.ts";
import { runImage } from "./run-image.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }

test("syntax memoization hashes every read, separates parser names and never caches failure", async () => {
  const root = await fixture(), file = join(root, "input.ts"), cache = new SyntaxCache(2);
  await writeFile(file, 'const text = "with { type: macro }";');
  await cache.check(file, "input.ts"); await cache.check(file, "input.ts"); await cache.check(file, "input.tsx");
  expect(cache.stats.parsed).toBe(2); expect(cache.stats.reused).toBe(1);
  await writeFile(file, 'import value from "macro:example";');
  await expect(cache.check(file, "input.ts")).rejects.toThrow("macros");
  await expect(cache.check(file, "input.ts")).rejects.toThrow("macros");
  expect(cache.stats.reused).toBe(1);
});

test("bounded jobs preserve order and drain in-flight work before rejecting", async () => {
  let active = 0, peak = 0;
  const result = await mapJobs([0, 1, 2, 3, 4, 5], 3, async (value) => {
    peak = Math.max(peak, ++active); await Bun.sleep((6 - value) * 2); active--; return value;
  });
  expect(peak).toBe(3); expect(result).toEqual([0, 1, 2, 3, 4, 5]);
  const started: number[] = [];
  await expect(mapJobs([0, 1, 2, 3], 2, async (value) => {
    started.push(value); active++;
    try { if (value === 0) { await Bun.sleep(2); throw new Error("stop"); } await Bun.sleep(15); return value; }
    finally { active--; }
  })).rejects.toThrow("stop");
  expect(active).toBe(0); expect(started).toEqual([0, 1]);
});

test("application cache skips installs/bundles, survives corruption and invalidates source edits", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache };
  const first = await build({ ...options, output: join(root, "cold") });
  let log = "";
  const second = await build({ ...options, output: join(root, "warm"), log: (text) => { log += text; } });
  expect(second.root).toEqual(first.root);
  expect(second.cache.find((c) => c.kind === "app")!.status).toBe("local");
  expect(log).not.toContain("Bundling"); expect(log).not.toContain("Preparing build dependencies");
  expect(await runImage(second, join(root, "run"))).toBe("fixture-msg works");
  const layer = second.layers.find((l) => l.kind === "app")!;
  await writeFile(new BlobStore(options.cacheDir).path(layer.descriptor.digest), "corrupt");
  const repaired = await build({ ...options, output: join(root, "repaired") });
  expect(repaired.root).toEqual(first.root); expect(repaired.cache.find((c) => c.kind === "app")!.status).toBe("miss");
  await writeFile(join(f.source, "src/server.ts"), 'console.log("changed");');
  const changed = await build({ ...options, output: join(root, "changed") });
  expect(changed.root.digest).not.toBe(first.root.digest); expect(changed.cache.find((c) => c.kind === "app")!.status).toBe("miss");
  const checked = await build({ ...options, output: join(root, "checked"), verifyDeterministic: true });
  expect(checked.root).toEqual(changed.root); expect(checked.cache.every((c) => c.status === "bypass")).toBe(true);
});

test("parallel workspace builds preserve root order/digests and never publish after a prepare failure", async () => {
  const root = await fixture(), f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  const options = { path: f.source, baseLayout: base, push: false, localCache: false, registryCache: false, gitMetadata: false, installCache: f.cache, sharedDeps: true };
  const serial = await buildTargets({ ...options, jobs: 1, output: join(root, "serial") });
  const parallel = await buildTargets({ ...options, jobs: 2, output: join(root, "parallel") });
  expect(parallel.map((r) => [r.target, r.root])).toEqual(serial.map((r) => [r.target, r.root]));
  expect(parallel[0]!.syntaxValidation!.reused).toBeGreaterThan(0);
  await writeFile(join(f.source, "services/worker/src/server.ts"), 'import "missing-package";');
  const registry = new MockRegistry();
  await expect(buildTargets({ ...options, push: true, repo: "registry.test/demo", jobs: 2, registry: { fetcher: registry.fetch, credentials: async () => undefined } })).rejects.toThrow("Bun build failed");
  expect(registry.requests).toHaveLength(0);
});

test("independent processes cannot overwrite a different output under the same cache key", async () => {
  const root = await fixture(), store = new BlobStore(join(root, "store")), directory = join(root, "cache");
  const layers = [];
  for (const value of ["first", "second"]) layers.push((await packLayer(store, [{ path: "app/file", type: "file", content: Buffer.from(value) }], "assets", 0))!);
  const key = cacheKey("collision"), script = join(root, "writer.ts");
  await writeFile(script, `import {LayerCache} from ${JSON.stringify(resolve("packages/bunko/cache.ts"))};\nimport {BlobStore} from ${JSON.stringify(resolve("packages/oci/blob-store.ts"))};\ntry {await new LayerCache(new BlobStore(process.argv[2]),{directory:process.argv[3],log:()=>{}}).remember(JSON.parse(process.argv[4]));}catch(e){console.error(e.message);process.exitCode=1;}`);
  const results = await Promise.all(layers.map(async (layer) => {
    const record = { schemaVersion: 1, key, kind: "assets", packFormat, destination: "/app", platform: null, layer, inventory: [], native: [] };
    const child = Bun.spawn([process.execPath, script, store.root, directory, JSON.stringify(record)], { stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); return { exit, stderr };
  }));
  expect(results.map((r) => r.exit).sort()).toEqual([0, 1]);
  expect(results.find((r) => r.exit)!.stderr).toContain("same cache key");
  const record = JSON.parse(await readFile(join(directory, "keys/assets", `${key.slice(7)}.json`), "utf8"));
  expect(layers.some((l) => l.descriptor.digest === record.layer.descriptor.digest)).toBe(true);
});

test("missing registry cache blobs become misses before publication", async () => {
  const root = await fixture(), f = await dependencyFixture(root), base = await baseLayout(join(root, "base")), remote = new MockRegistry();
  const options = { path: f.source, baseLayout: base, repo: "registry.test/team", localCache: false, gitMetadata: false, installCache: f.cache, registry: { fetcher: remote.fetch, credentials: async () => undefined } };
  const first = await build(options);
  const app = first.layers.find((layer) => layer.kind === "app")!;
  for (const key of remote.blobs.keys()) if (key.endsWith(`/${app.descriptor.digest}`)) remote.blobs.delete(key);
  const second = await build(options);
  expect(second.root).toEqual(first.root);
  expect(second.cache.find((event) => event.kind === "app")!.status).toBe("miss");
  const disabled = await build({ ...options, appCache: false });
  expect(disabled.cache.find((event) => event.kind === "app")!.status).toBe("bypass");
});
