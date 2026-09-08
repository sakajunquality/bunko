import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { moduleLocations, validateLocations } from "../packages/bunko/location-diagnostics.ts";
import { guardedBuild } from "../packages/bunko/bundle-worker.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, project, temporary } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await temporary(); roots.push(root); return root; }

test("location analysis reports actual references, not comments, keys, types or lexical bindings", () => {
  expect(moduleLocations(`// import.meta.dir
    const text = "__dirname import.meta.url";
    const obj = { __dirname: 1, __filename() {} };
    obj.__dirname;
    import type { __dirname } from "types";
    type T = typeof __filename;
    function f(__dirname: string) { return __dirname; }
    { const {x: __filename} = obj; console.log(__filename); }
    function hoisted() { console.log(__dirname); if (true) { var __dirname = "x"; } }
    try {} catch (__dirname) { console.log(__dirname); }
  `, "src/input.ts")).toEqual([]);
  const warnings = moduleLocations('console.log(__dirname, { __filename }, import.meta.dir, import.meta["url"], import.meta.dir);', "lib/data.ts");
  expect(warnings.map((w) => w.expression)).toEqual(["__dirname", "__filename", "import.meta.dir", "import.meta.url"]);
  expect(warnings[0]).toEqual({ code: "BUNKO_MODULE_LOCATION", file: "lib/data.ts", line: 1, column: 13, expression: "__dirname" });
  expect(() => validateLocations({ total: 1, warnings: [{ ...warnings[0], file: "../host" }] })).toThrow();
});

test("loaded entries, shared modules and bundled dependencies warn; unloaded and external files do not", async () => {
  const root = await fixture();
  await mkdir(join(root, "node_modules/probe"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "shared.ts"), 'export const where = import.meta.dir;');
  await writeFile(join(root, "one.ts"), 'import {where} from "./shared"; import probe from "probe"; console.log(import.meta.url, where, probe);');
  await writeFile(join(root, "two.ts"), 'import {where} from "./shared"; console.log(where);');
  await writeFile(join(root, "unused.ts"), 'console.log(import.meta.path);');
  await writeFile(join(root, "node_modules/probe/package.json"), '{"name":"probe","main":"index.ts"}');
  await writeFile(join(root, "node_modules/probe/index.ts"), 'export default import.meta.dir;');
  for (const external of [[], ["probe"]]) {
    const result = await guardedBuild({ root, contextRoot: root, entrypoint: "one.ts", entrypoints: { one: "one.ts", two: "two.ts" }, outdir: join(root, `out-${external.length}`), external, minify: false, sourcemap: "none", define: {} });
    expect(result.success).toBe(true);
    expect(result.locations.warnings.map((w) => w.file)).toEqual(external.length ? ["one.ts", "shared.ts"] : ["node_modules/probe/index.ts", "one.ts", "shared.ts"]);
  }
});

test("reports and logs replay location diagnostics on an application cache hit", async () => {
  const root = await fixture(), source = await project(join(root, "source"), {}, 'console.log(import.meta.dir);');
  const options = { path: source, baseLayout: await baseLayout(join(root, "base")), cacheDir: join(root, "cache"), registryCache: false, gitMetadata: false, push: false };
  const cold = await build({ ...options, output: join(root, "cold") });
  let logs = "";
  const warm = await build({ ...options, output: join(root, "warm"), log: (text) => { logs += text; } });
  expect(warm.cache.some((c) => c.kind === "app" && c.status === "local")).toBe(true);
  expect(warm.images[0]!.locations).toEqual(cold.images[0]!.locations);
  expect(warm.images[0]!.locations!.total).toBe(1);
  expect(logs).toContain("BUNKO_MODULE_LOCATION src/server.ts:1:13");
  expect(logs).not.toContain(source);
});

test("bundling reproduces missing module-relative data and an explicit root restores reads", async () => {
  const root = await fixture();
  await mkdir(join(root, "lib")); await mkdir(join(root, "data"));
  await writeFile(join(root, "data/manifest.json"), '["one","two","three"]');
  await writeFile(join(root, "main.ts"), 'import { read } from "./lib/catalog"; console.log(read());');
  await writeFile(join(root, "lib/catalog.ts"), 'import {resolve} from "node:path"; import {existsSync,readFileSync} from "node:fs"; export function read() { const file=resolve(process.env.APP_ROOT || resolve(import.meta.dir,".."), "data/manifest.json"); return existsSync(file)?JSON.parse(readFileSync(file,"utf8")).length:0; }');
  const result = await guardedBuild({ root, contextRoot: root, entrypoint: "main.ts", outdir: join(root, "out"), external: [], minify: false, sourcemap: "none", define: {} });
  expect(result.success).toBe(true);
  await mkdir(join(root, "out/data")); await writeFile(join(root, "out/data/manifest.json"), '["one","two","three"]');
  // Remove the original data so only the image-equivalent emitted tree remains.
  await rm(join(root, "data"), { recursive: true });
  for (const [env, expected] of [[{}, "0"], [{ APP_ROOT: join(root, "out") }, "3"]] as const) {
    const child = Bun.spawn([process.execPath, join(root, "out/main.js")], { env, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe(expected); expect(await child.exited).toBe(0);
  }
});
