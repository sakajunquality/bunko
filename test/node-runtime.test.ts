import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadProject } from "../packages/bunko/config.ts";
import { build } from "../packages/bunko/build.ts";
import { nodeArguments, nodeBase, nodeMajor, nodePath } from "../packages/bunko/node-runtime.ts";
import { rejectBunRuntime } from "../packages/bunko/node-syntax.ts";
import { rebase } from "../packages/bunko/rebase.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { rebaseBase, rebaseRuntime } from "./rebase-fixture.ts";
import { temporary, inspectTar } from "./helpers.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(mode: "bundle" | "source" = "bundle", code = 'import { basename } from "node:path"; console.log(basename("/a/node-ok"));') {
  const root = await temporary(); dirs.push(root); const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "node-fixture", type: "module", module: "index.js", bunko: { mode, runtime: { kind: "node", node: "24", nodePath: "/usr/local/bin/node" } } }));
  await writeFile(join(source, "index.js"), code);
  const bytes = rebaseRuntime({ os: "linux", architecture: "amd64" }); bytes.fill(0, 800);
  const base = await rebaseBase(join(root, "base"), undefined, {}, [{ path: "usr/local/bin/node", type: "file", content: bytes, executable: true }]);
  return { root, source, base };
}
test("Node configuration selects supported bases and separate runtime arguments", async () => {
  expect(nodeMajor(undefined)).toBe("24"); expect(nodeMajor(undefined, "^22.0.0")).toBe("22");
  expect(nodeBase("24", "glibc")).toBe("gcr.io/distroless/nodejs24-debian13"); expect(nodeBase("24", "musl")).toBe("node:24-alpine");
  expect(nodePath("node:24-alpine", undefined, undefined, "musl")).toBe("/usr/local/bin/node");
  expect(() => nodePath("registry.test/custom", undefined, undefined, "glibc")).toThrow("nodePath");
  expect(() => nodePath(undefined, undefined, "relative-node", "glibc")).toThrow("absolute");
  expect(nodeArguments(["--max-old-space-size", "128"])).toEqual(["--max-old-space-size=128"]);
  expect(() => nodeArguments(["--smol"])).toThrow("Node"); expect(() => nodeArguments(["--eval", "secret"])).toThrow("Node");
  const f = await fixture(); await expect(loadProject({ path: f.source, mode: "compile" })).rejects.toThrow("Node runtime");
  await expect(loadProject({ path: f.source, runtimeInject: "release" })).rejects.toThrow("Node runtime");
});
test("Node guards ignore comments, strings and local bindings while rejecting runtime APIs", () => {
  for (const code of ['// Bun.serve()\nconsole.log("bun:sqlite")', 'function f(Bun) { return Bun.value; }', 'const x={Bun:1};', 'type Bun = string;']) expect(() => rejectBunRuntime(code, "fixture.ts")).not.toThrow();
  for (const code of ['Bun.serve({})', 'import {Database} from "bun:sqlite"', 'await import("bun:sqlite")', 'require("bun:sqlite")', 'import.meta.require("x")', 'import /* comment */ .meta.require("x")', 'globalThis["Bun"].serve()', 'B\\u0075n.serve()']) expect(() => rejectBunRuntime(code, "fixture.ts")).toThrow("Bun-only");
  expect(() => rejectBunRuntime('// import "./file.ts"', "app.js", undefined, true)).not.toThrow();
  expect(() => rejectBunRuntime('import "./file.ts"', "app.js", undefined, true)).toThrow("TypeScript");
});
test.each(["bundle", "source"] as const)("Node %s emits a Node entrypoint, environment and SBOM; host Node executes the payload", async (mode) => {
  const f = await fixture(mode), output = join(f.root, "image");
  const result = await build({ path: f.source, baseLayout: f.base.directory, output, localCache: false, gitMetadata: false, sbom: true, provenance: true });
  const store = new BlobStore(output), config = JSON.parse(Buffer.from(await store.read(result.config)).toString()).config;
  expect(config.Entrypoint).toEqual(["/usr/local/bin/node", mode === "bundle" ? "/app/index.mjs" : "/app/index.js"]);
  expect(config.Env).toContain("NODE_ENV=production"); expect(config.Env.some((e: string) => e.startsWith("BUN_RUNTIME_"))).toBe(false);
  expect(config.Labels["org.bunko.runtime.kind"]).toBe("node");
  const app = result.layers.find((l) => l.kind === "app")!, entries = await inspectTar(store.path(app.descriptor.digest));
  const payload = entries.find((e) => e.name === config.Entrypoint[1].slice(1))!; expect(payload.content).toBeTruthy();
  const path = join(f.root, "run.mjs"); await writeFile(path, payload.content!);
  const node = Bun.which("node"); if (!node) throw new Error("Node tests require Node on PATH");
  const child = Bun.spawn([node, path], { stdout: "pipe", stderr: "pipe" }); expect(await new Response(child.stdout).text()).toContain("node-ok"); expect(await child.exited).toBe(0);
  const { spdx } = await import("../packages/bunko/attest.ts"); const sbom = spdx("node-fixture", result.images[0]!, 0, { version: Bun.version, revision: Bun.revision, embedded: false });
  expect(sbom.packages.find((p) => p.name === "node")?.versionInfo).toBe("24"); expect(sbom.packages.some((p) => p.name === "bun")).toBe(false);
  expect(result.buildParameters!.runtime).toMatchObject({ kind: "node", versionVerified: false });
});
test("Node source rejects TypeScript and Bun APIs before contacting a registry", async () => {
  const f = await fixture("source", "Bun.serve({})"); let network = false;
  await expect(build({ path: f.source, base: "registry.test/base", output: join(f.root, "bad"), localCache: false, registry: { fetcher: async () => { network = true; throw new Error("network"); } } })).rejects.toThrow("Bun-only");
  expect(network).toBe(false);
  await writeFile(join(f.source, "index.js"), "console.log(1)"); await writeFile(join(f.source, "unbuilt.ts"), "export const n: number = 1");
  await expect(build({ path: f.source, baseLayout: f.base.directory, output: join(f.root, "bad-ts"), localCache: false })).rejects.toThrow("JavaScript source");
});
test("Node rebase uses identical executable bytes without requiring a Bun revision", async () => {
  const f = await fixture(), output = join(f.root, "image");
  const built = await build({ path: f.source, baseLayout: f.base.directory, output, localCache: false, gitMetadata: false, sbom: true });
  const result = await rebase({ image: `layout:${output}`, oldBase: `layout:${f.base.directory}`, base: `layout:${f.base.directory}`, output: join(f.root, "rebased"), sbom: true });
  expect(result.platforms[0]!.preservedLayers).toEqual(built.layers.map((l) => l.descriptor.digest));
  expect(result.decision).toBe("compatible");
});

test("Node resolves Bun's isolated production dependency tree and rejects Bun APIs in external packages", async () => {
  const f = await fixture(); const { dependencyFixture } = await import("./dependency-fixture.ts"), { runImage } = await import("./run-image.ts");
  const deps = await dependencyFixture(join(f.root, "deps"), true), path = join(deps.source, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")); manifest.bunko.runtime = { kind: "node", node: "24", nodePath: "/usr/local/bin/node" }; await writeFile(path, JSON.stringify(manifest));
  const options = { path: deps.source, baseLayout: f.base.directory, installCache: deps.cache, localCache: false, gitMetadata: false };
  const result = await build({ ...options, output: join(f.root, "deps-image") });
  expect(await runImage(result, join(f.root, "unpacked"))).toBe("fixture-msg works");
  await writeFile(join(deps.cache, "fixture-msg@1.0.0@@@1", "index.js"), 'module.exports = Bun.version;');
  await expect(build({ ...options, output: join(f.root, "incompatible") })).rejects.toThrow("Bun-only");
});

test("deep diagnostics surface Node runtime policy and reject Bun APIs offline", async () => {
  const f = await fixture(); const { checkConfig } = await import("../packages/bunko/diagnostics.ts");
  const result = await checkConfig({ path: f.source, deep: true });
  expect(result.targets[0]).toMatchObject({ runtimeKind: "node", nodeVersion: "24", sourceTypeScript: false, runtimePath: "/usr/local/bin/node" });
  await writeFile(join(f.source, "index.js"), 'Bun.serve({})'); await expect(checkConfig({ path: f.source, deep: true })).rejects.toThrow("Bun-only");
});

test("unused Bun test files do not block Node bundles; loaded bare Bun imports and heritage do", async () => {
  const f = await fixture(); await writeFile(join(f.source, "unused.test.ts"), 'import { test } from "bun:test"; test("unused",()=>{});');
  const options = { path: f.source, baseLayout: f.base.directory, localCache: false, gitMetadata: false };
  await build({ ...options, output: join(f.root, "valid") });
  for (const [index, code] of ['import {serve} from "bun";', 'class A extends Bun.X {}'].entries()) {
    await writeFile(join(f.source, "index.js"), code); await expect(build({ ...options, output: join(f.root, `invalid-${index}`) })).rejects.toThrow("Bun-only");
  }
  for (const code of ['typeof Bun !== "undefined"', 'const {Bun: value} = object;', 'class A implements Bun.Type {}']) expect(() => rejectBunRuntime(code, "fixture.ts")).not.toThrow();
  const { moduleLocations } = await import("../packages/bunko/location-diagnostics.ts"); expect(moduleLocations('class A extends f(__dirname) {}', 'fixture.js')).toHaveLength(0);
});
test("Node SBOM rebasing rejects a runtime kind or declared-major mismatch", async () => {
  const f = await fixture(), built = await build({ path: f.source, baseLayout: f.base.directory, output: join(f.root, "image"), localCache: false, gitMetadata: false });
  const { spdx } = await import("../packages/bunko/attest.ts"), { rebaseSpdx } = await import("../packages/bunko/rebase-attest.ts");
  const document = spdx("node-fixture", built.images[0]!, 0);
  expect(() => rebaseSpdx(document, built.manifest, built.manifest, built.images[0]!.platform, 0)).toThrow("Runtime inventory");
  expect(() => rebaseSpdx(document, built.manifest, built.manifest, built.images[0]!.platform, 0, undefined, { kind: "node", version: "22" })).toThrow("Runtime inventory");
  expect(() => rebaseSpdx(document, built.manifest, built.manifest, built.images[0]!.platform, 0, undefined, { kind: "node", version: "24" })).not.toThrow();
});
test("changed bases retain Node runtime bytes and still require a reviewed ABI policy", async () => {
  const f = await fixture(), output = join(f.root, "image"); await build({ path: f.source, baseLayout: f.base.directory, output, localCache: false, gitMetadata: false });
  const bytes = rebaseRuntime({ os: "linux", architecture: "amd64" }); bytes.fill(0, 800);
  const next = await rebaseBase(join(f.root, "next"), undefined, {}, [{ path: "usr/local/bin/node", type: "file", content: bytes, executable: true }, { path: "etc/update", type: "file", content: Buffer.from("new") }]);
  const options = { image: `layout:${output}`, oldBase: `layout:${f.base.directory}`, base: `layout:${next.directory}`, dryRun: true };
  await expect(rebase(options)).rejects.toMatchObject({ decision: "requires-policy" });
  const { rebasePolicyTemplate } = await import("../packages/bunko/rebase-operations.ts"); const policy = join(f.root, "policy.json");
  const template = await rebasePolicyTemplate({ ...options, out: policy }); await writeFile(policy, JSON.stringify({ ...template.policy, reviewed: true }));
  expect((await rebase({ ...options, policy })).decision).toBe("compatible");
  bytes[900] = 1; const changed = await rebaseBase(join(f.root, "changed"), undefined, {}, [{ path: "usr/local/bin/node", type: "file", content: bytes, executable: true }]);
  await expect(rebase({ ...options, base: `layout:${changed.directory}`, policy })).rejects.toMatchObject({ decision: "requires-rebuild", reason: "runtime-changed" });
});


test("Node feature detection permits unreachable Bun branches but still rejects reachable APIs", () => {
  for (const code of [
    'const version = typeof Bun !== "undefined" ? Bun.version : undefined;',
    'if (typeof Bun !== "undefined") { Bun.serve({}); } else console.log("node");',
    'typeof Bun !== "undefined" && Bun.version;',
    'typeof Bun < "u" ? Bun.version : undefined;',
    'typeof Bun === "undefined" || Bun.version;',
  ]) expect(() => rejectBunRuntime(code, "portable.js")).not.toThrow();
  for (const code of ['typeof Bun === "undefined" && Bun.serve({})', 'typeof Bun !== "undefined" ? null : Bun.version', 'if (unknown) Bun.serve({})']) expect(() => rejectBunRuntime(code, "invalid.js")).toThrow("Bun-only");
});

test("official Node base majors are inferred and conflicting declarations fail", () => {
  expect(nodeMajor(undefined, undefined, "node:22-alpine")).toBe("22");
  expect(nodeMajor(undefined, undefined, "node:24.2.0-bookworm")).toBe("24");
  expect(nodeMajor(undefined, undefined, "gcr.io/distroless/nodejs22-debian13")).toBe("22");
  expect(() => nodeMajor("24", undefined, "node:22-alpine")).toThrow("conflicts");
  expect(() => nodeMajor(undefined, undefined, "node:latest")).toThrow("runtime.node");
  expect(() => nodeMajor(undefined, undefined, undefined, "/local/layout")).toThrow("runtime.node");
});

test.each(["bundle", "source"] as const)("unused dependency adapters do not block Node %s, including app/deps cache hits", async (mode) => {
  const f = await fixture(mode), { dependencyFixture } = await import("./dependency-fixture.ts"), { runImage } = await import("./run-image.ts");
  const deps = await dependencyFixture(join(f.root, "deps"), true), path = join(deps.source, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")); manifest.bunko.mode = mode; manifest.bunko.runtime = { kind: "node", node: "24", nodePath: "/usr/local/bin/node" };
  if (mode === "source") {
    manifest.module = "index.js";
    await writeFile(join(deps.source, "index.js"), await readFile(join(deps.source, "src/server.ts")));
    await rm(join(deps.source, "src/server.ts"));
  }
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(deps.cache, "fixture-msg@1.0.0@@@1", "bun-adapter.js"), 'import {serve} from "bun"; serve({});');
  await writeFile(join(deps.cache, "fixture-msg@1.0.0@@@1", "index.js"), 'module.exports = typeof Bun !== "undefined" ? Bun.version : "portable-node";');
  const options = { path: deps.source, baseLayout: f.base.directory, installCache: deps.cache, cacheDir: join(f.root, "cache"), gitMetadata: false };
  for (const label of ["cold", "warm"]) {
    const result = await build({ ...options, output: join(f.root, label) });
    expect(await runImage(result, join(f.root, `run-${label}`))).toContain("portable-node");
  }
});

test("Node guard treats JSX component names and member objects as runtime references", () => {
  for (const code of ["const x = <Bun />", "const x = <Bun.file />", "const x = <globalThis.Bun />"]) expect(() => rejectBunRuntime(code, "component.tsx")).toThrow("Bun-only runtime API");
  for (const code of ["function render(Bun) { return <Bun.file /> }", "const x = <Component Bun='attribute' />", "const x = <Components.Bun />"]) expect(() => rejectBunRuntime(code, "component.tsx")).not.toThrow();
});
