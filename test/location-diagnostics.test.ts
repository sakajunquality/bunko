import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { locationHint, locationPackage, locationPackages, moduleLocations, validateLocations } from "../packages/bunko/location-diagnostics.ts";
import { guardedBuild } from "../packages/bunko/bundle-worker.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await temporary(); roots.push(root); return root; }

test("location analysis reports actual references, not comments, keys, types or lexical bindings", () => {
  expect(moduleLocations(`// import.meta.dir
    const text = "__dirname import.meta.url";
    const obj = { __dirname: 1, __filename() {} };
    obj.__dirname; const { __dirname: dir } = obj; enum Names { __filename }
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

test("flagged dependency packages are derived from the final node_modules segment and resolved to declared dependencies", () => {
  expect(locationPackage("node_modules/.bun/@google-cloud+spanner@8.6.0/node_modules/@google-cloud/spanner/build/src/index.js")).toBe("@google-cloud/spanner");
  expect(locationPackage("node_modules/.bun/google-gax@5.0.6/node_modules/google-gax/build/src/grpc.js")).toBe("google-gax");
  expect(locationPackage("node_modules/.bun/pkg@1.0.0+abc123/node_modules/pkg/index.js")).toBe("pkg");
  expect(locationPackage("packages/api/node_modules/@scope/name/lib/index.js")).toBe("@scope/name");
  expect(locationPackage("node_modules/plain/index.js")).toBe("plain");
  for (const file of ["src/server.ts", "lib/node_modules.ts", "node_modules/.bun/pkg@1.0.0/node_modules/@scope", "node_modules/@scope", "node_modules/index.js", "node_modules/.hidden/index.js", "node_modules/bad name/index.js"]) expect(locationPackage(file)).toBeUndefined();
  const edges: [string | undefined, string][] = [[undefined, "@google-cloud/spanner"], [undefined, "hono"], [undefined, "hoisted"], ["@google-cloud/spanner", "google-gax"], ["google-gax", "@grpc/grpc-js"], ["google-gax", "google-gax"], ["hoisted", "orphan"]];
  const packages = locationPackages(["google-gax", "@grpc/grpc-js", "@google-cloud/spanner", "orphan", "google-gax"], ["@google-cloud/spanner", "hono"], edges);
  expect(packages).toEqual([{ name: "@google-cloud/spanner", declared: true, via: [] }, { name: "@grpc/grpc-js", declared: false, via: ["@google-cloud/spanner"] }, { name: "google-gax", declared: false, via: ["@google-cloud/spanner"] }, { name: "orphan", declared: false, via: [] }]);
  expect(locationHint(packages)).toBe('Add "@google-cloud/spanner" to bunko.external so it stays in node_modules with its module-relative files (@grpc/grpc-js, google-gax reached through @google-cloud/spanner). "orphan" is flagged inside node_modules without a declared dependency path; externalize the declared dependency that loads it');
  expect(locationHint(packages.slice(0, 1))).toBe('Add "@google-cloud/spanner" to bunko.external so it stays in node_modules with its module-relative files');
  expect(locationHint(locationPackages(["a", "b"], ["a", "b"], []))).toBe('Add "a", "b" to bunko.external so they stay in node_modules with their module-relative files');
  expect(locationHint([])).toBeUndefined(); expect(locationHint(undefined)).toBeUndefined();
  const valid = { total: 0, warnings: [], packages };
  expect(validateLocations(valid)).toBe(valid);
  for (const bad of [[packages[1], packages[0]], [{ ...packages[0], via: ["hono"] }], [{ ...packages[0], name: "../x" }], [{ ...packages[1], via: ["b", "a"] }], [{ name: "x", declared: false }], packages[0]]) expect(() => validateLocations({ total: 0, warnings: [], packages: bad })).toThrow();
});

test("loaded entries, shared modules and bundled dependencies warn; unloaded and external files do not", async () => {
  const root = await fixture();
  // Bun's isolated layout: node_modules/<name> links into node_modules/.bun/<id>/node_modules/<name>.
  for (const [name, code] of [["probe", 'import nested from "nested"; export default import.meta.dir + nested;'], ["nested", 'export default __dirname;']] as const) {
    await mkdir(join(root, `node_modules/.bun/${name}@1.0.0/node_modules/${name}`), { recursive: true });
    await writeFile(join(root, `node_modules/.bun/${name}@1.0.0/node_modules/${name}/package.json`), `{"name":"${name}","main":"index.ts"}`);
    await writeFile(join(root, `node_modules/.bun/${name}@1.0.0/node_modules/${name}/index.ts`), code);
  }
  await symlink("./.bun/probe@1.0.0/node_modules/probe", join(root, "node_modules/probe"));
  await symlink("../../nested@1.0.0/node_modules/nested", join(root, "node_modules/.bun/probe@1.0.0/node_modules/nested"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "shared.ts"), 'export const where = import.meta.dir;');
  await writeFile(join(root, "one.ts"), 'import {where} from "./shared"; import probe from "probe"; console.log(import.meta.url, where, probe);');
  await writeFile(join(root, "two.ts"), 'import {where} from "./shared"; console.log(where);');
  await writeFile(join(root, "unused.ts"), 'console.log(import.meta.path);');
  for (const external of [[], ["probe"]]) {
    const result = await guardedBuild({ root, contextRoot: root, entrypoint: "one.ts", entrypoints: { one: "one.ts", two: "two.ts" }, outdir: join(root, `out-${external.length}`), external, dependencies: ["probe"], minify: false, sourcemap: "none", define: {} });
    expect(result.success).toBe(true);
    expect(result.locations.warnings.map((w) => w.file)).toEqual(external.length ? ["one.ts", "shared.ts"] : ["node_modules/.bun/nested@1.0.0/node_modules/nested/index.ts", "node_modules/.bun/probe@1.0.0/node_modules/probe/index.ts", "one.ts", "shared.ts"]);
    expect(result.locations.packages).toEqual(external.length ? [] : [{ name: "nested", declared: false, via: ["probe"] }, { name: "probe", declared: true, via: [] }]);
    expect(locationHint(result.locations.packages)).toBe(external.length ? undefined : 'Add "probe" to bunko.external so it stays in node_modules with its module-relative files (nested reached through probe)');
  }
  // Application-only warnings never produce an externalization hint.
  const application = await guardedBuild({ root, contextRoot: root, entrypoint: "two.ts", outdir: join(root, "out-app"), external: [], dependencies: ["probe"], minify: false, sourcemap: "none", define: {} });
  expect(application.locations.packages).toEqual([]);
});

test("builds print an externalization hint for flagged dependencies and error mode fails after listing them", async () => {
  const root = await fixture(), f = await dependencyFixture(root, false), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports = __dirname;');
  const manifest = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
  const options = { path: f.source, baseLayout: base, installCache: f.cache, localCache: false, registryCache: false, gitMetadata: false, push: false };
  let logs = "";
  const result = await build({ ...options, output: join(root, "warn"), log: (text) => { logs += text; } });
  expect(result.images[0]!.locations!.packages).toEqual([{ name: "fixture-msg", declared: true, via: [] }]);
  expect(logs).toContain('BUNKO_MODULE_LOCATION node_modules/.bun/fixture-msg@1.0.0/node_modules/fixture-msg/index.js:1:18 (__dirname)\nAdd "fixture-msg" to bunko.external so it stays in node_modules with its module-relative files\n');
  manifest.bunko.build = { moduleLocations: "error" };
  await writeFile(join(f.source, "package.json"), JSON.stringify(manifest));
  logs = "";
  await expect(build({ ...options, output: join(root, "error"), log: (text) => { logs += text; } })).rejects.toThrow("Module-location diagnostics fail this build (build.moduleLocations=error): 1 flagged reference");
  expect(logs).toContain('Add "fixture-msg" to bunko.external');
  // The invocation override wins over the manifest, and externalizing the package clears its warning.
  await build({ ...options, output: join(root, "override"), moduleLocations: "warn" });
  manifest.bunko.external = ["fixture-msg"];
  await writeFile(join(f.source, "package.json"), JSON.stringify(manifest));
  const clean = await build({ ...options, output: join(root, "external") });
  expect(clean.images[0]!.locations).toEqual({ total: 0, warnings: [], packages: [] });
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
  expect(result.locations.warnings[0]!.file).toBe("lib/catalog.ts");
  await mkdir(join(root, "out/data")); await writeFile(join(root, "out/data/manifest.json"), '["one","two","three"]');
  // Remove the original data so only the image-equivalent emitted tree remains.
  await rm(join(root, "data"), { recursive: true });
  for (const [env, expected] of [[{}, "0"], [{ APP_ROOT: join(root, "out") }, "3"]] as const) {
    const child = Bun.spawn([process.execPath, join(root, "out/main.js")], { env, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe(expected); expect(await child.exited).toBe(0);
  }
});


test("diagnostic validation rejects malformed worker/cache data", () => {
  const item = moduleLocations("console.log(__dirname)", "src/main.ts")[0]!;
  for (const change of [{ file: "/host/input.ts" }, { file: "bad\\path" }, { file: "bad\npath" }, { line: 0 }, { column: 1.5 }, { expression: "unknown" }]) expect(() => validateLocations({total:1, warnings:[{...item, ...change}]})).toThrow();
  expect(() => validateLocations({total:2, warnings:[item]})).toThrow();
  expect(() => validateLocations({total:2, warnings:[item,item]})).toThrow();
  expect(moduleLocations("console.log(\\u005f_dirname)", "input.js")[0]!.expression).toBe("__dirname");
});

test("loaded diagnostics retain a deterministic bounded prefix", async () => {
  const root = await fixture();
  let main = "";
  for (let i=0;i<105;i++) {
    const name = `module-${String(i).padStart(3,"0")}.ts`;
    await writeFile(join(root,name), "console.log(import.meta.dir);"); main += `import "./${name}";\n`;
  }
  await writeFile(join(root,"main.ts"),main);
  const result = await guardedBuild({root,contextRoot:root,entrypoint:"main.ts",outdir:join(root,"out"),external:[],minify:false,sourcemap:"none",define:{}});
  expect(result.success).toBe(true); expect(result.locations.total).toBe(105); expect(result.locations.warnings.length).toBe(100);
  expect(result.locations.warnings.at(-1)!.file).toBe("module-099.ts");
});
