import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { bareSpecifierPackage, candidateRuntimeFile, declaredNames, importSpecifiers, manifestEntryPoints, reachableUndeclaredImports, scannableRuntimeFile, testLocation, undeclaredImportPolicy, undeclaredImportSizeLimit, undeclaredImports } from "../packages/bunko/undeclared-imports.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

test("scan reports package names from static imports, re-exports, requires and dynamic imports", () => {
  const code = 'import a from "alpha/sub"; export * from "@scope/beta/deep/file.js"; const c = require("gamma"); const d = import("delta"); try { require("supports-color") } catch {}';
  expect(undeclaredImports(code, new Set())).toEqual(["@scope/beta", "alpha", "delta", "gamma", "supports-color"]);
  expect(undeclaredImports(code, new Set(["alpha", "@scope/beta", "gamma", "delta", "supports-color"]))).toEqual([]);
});

test("builtin, protocol, relative, subpath-import, self, declared and optional-peer names are resolved", () => {
  const manifest = { name: "@scope/self", dependencies: { dep: "1" }, optionalDependencies: { opt: "1" }, peerDependencies: { peer: "*", "optional-peer": "*" }, peerDependenciesMeta: { "optional-peer": { optional: true } } };
  const declared = declaredNames(manifest);
  expect([...declared].sort()).toEqual(["@scope/self", "dep", "opt", "optional-peer", "peer"]);
  const code = 'require("fs"); require("node:fs/promises"); require("bun"); require("bun:sqlite"); import "#internal/x"; require("./local"); require("../up.js"); require("/abs"); import("data:text/javascript,1"); require("@scope/self/package.json"); require("dep/x"); require("opt"); require("peer"); require("optional-peer"); require(dynamic); require("missing");';
  expect(undeclaredImports(code, declared)).toEqual(["missing"]);
  for (const specifier of ["fs", "node:test", "bun", "bun:ffi", "#x", "./a", "/a", "http://x", "", "@scope", "@scope/"]) expect(bareSpecifierPackage(specifier)).toBeUndefined();
  expect(bareSpecifierPackage("@scope/name/sub")).toBe("@scope/name");
  expect(bareSpecifierPackage("name/sub/deep")).toBe("name");
});

test("scan skips unparseable and import-free files and respects the file filter", () => {
  expect(undeclaredImports("const x = <div/>; require('jsx-only');", new Set())).toEqual([]);
  expect(undeclaredImports("module.exports = 1;", new Set())).toEqual([]);
  expect(scannableRuntimeFile("lib/index.js", 10)).toBe(true);
  expect(scannableRuntimeFile("lib/index.cjs", 10)).toBe(true);
  expect(scannableRuntimeFile("lib/index.mjs", undeclaredImportSizeLimit)).toBe(true);
  expect(scannableRuntimeFile("lib/index.mjs", undeclaredImportSizeLimit + 1)).toBe(false);
  expect(scannableRuntimeFile("lib/index.d.ts", 10)).toBe(false);
  expect(scannableRuntimeFile("package.json", 10)).toBe(false);
  expect(undeclaredImportPolicy([{ undeclaredImports: "off" }, { undeclaredImports: "warn" }])).toBe("warn");
  expect(undeclaredImportPolicy([{ undeclaredImports: "off" }, { undeclaredImports: "error" }])).toBe("error");
  expect(undeclaredImportPolicy([{ undeclaredImports: "off" }])).toBe("off");
  expect(importSpecifiers('#!/usr/bin/env node\nrequire("./cli-impl"); import("x");')).toEqual(["./cli-impl", "x"]);
  for (const path of ["index.js", "lib/a.cjs", "lib/b.mjs", "package.json", "lib/package.json"]) expect(candidateRuntimeFile(path)).toBe(true);
  for (const path of ["index.d.ts", "README.md", "lib/data.json", "native.node", "packages.json"]) expect(candidateRuntimeFile(path)).toBe(false);
});

/** In-memory package: file contents keyed by package-relative path, sizes derived from the text. */
function memory(contents: Record<string, string>) {
  const files = new Map(Object.entries(contents).filter(([path]) => candidateRuntimeFile(path)).map(([path, text]) => [path, Buffer.byteLength(text)]));
  return { files, read: async (file: string) => { if (!(file in contents)) throw new Error(`unexpected read: ${file}`); return contents[file]!; } };
}

test("only files reachable from the entry points are scanned, so shipped tests do not produce findings", async () => {
  const pkg = { name: "tape-user", version: "1.0.0", main: "index.js" };
  const { files, read } = memory({ "package.json": JSON.stringify(pkg), "index.js": 'module.exports = require("fs");', "test.js": 'require("tape")(require("./index.js"));', "test/more.test.js": 'require("mocha");' });
  expect(await reachableUndeclaredImports(pkg, files, read)).toEqual([]);
  const loud = memory({ "package.json": JSON.stringify(pkg), "index.js": 'const c = require("supports-color"); module.exports = require("fs");', "test.js": 'require("tape");' });
  expect(await reachableUndeclaredImports(pkg, loud.files, loud.read)).toEqual([{ name: "supports-color", file: "index.js" }]);
});

test("every exports leaf counts as an entry: nested conditions, subpaths, arrays, patterns; null leaves and non-JS targets are ignored", async () => {
  const pkg = { name: "exporter", version: "1.0.0", exports: { ".": { import: { types: "./index.d.ts", default: "./esm/index.mjs" }, require: "./cjs/index.cjs" }, "./feature": ["./feature.js", { default: null }], "./data": "./data.json", "./addon": "./addon.node", "./plugins/*": "./plugins/*.js", "./package.json": "./package.json" } };
  const { files, read } = memory({ "package.json": JSON.stringify(pkg), "esm/index.mjs": 'import "node:fs";', "cjs/index.cjs": 'require("cjs-only");', "feature.js": 'require("feature-only");', "data.json": "{}", "addon.node": "", "plugins/a.js": 'require("plugin-a");', "plugins/b.test.js": 'require("plugin-test");', "index.d.ts": "", "unreached.js": 'require("unreached");' });
  expect(manifestEntryPoints(pkg, files.keys())).toEqual(["./index.d.ts", "./esm/index.mjs", "./cjs/index.cjs", "./feature.js", "./data.json", "./addon.node", "plugins/a.js", "plugins/b.test.js", "./package.json"]);
  expect(await reachableUndeclaredImports(pkg, files, read)).toEqual([{ name: "cjs-only", file: "cjs/index.cjs" }, { name: "feature-only", file: "feature.js" }, { name: "plugin-a", file: "plugins/a.js" }, { name: "plugin-test", file: "plugins/b.test.js" }]);
  expect(manifestEntryPoints({ main: "a.js", module: "b.mjs", exports: "./c.js", bin: { x: "bin/x.js", y: 7 }, browser: { "./a.js": "./browser.js" } }, [])).toEqual(["a.js", "b.mjs", "./c.js", "bin/x.js"]);
  expect(manifestEntryPoints({ bin: "cli.js", browser: "browser.js", main: 3 }, [])).toEqual(["cli.js", "browser.js"]);
});

test("relative import chains, extension probing, directory indexes and nested package.json mains are followed once each", async () => {
  const pkg = { name: "chain", version: "1.0.0", main: "./index", dependencies: { declared: "1" } };
  const reads: string[] = [];
  const { files, read } = memory({ "package.json": JSON.stringify(pkg), "index.js": 'require("./lib/a"); require("./lib"); require("./vendor"); require("./lib/a.js"); require("."); require("./missing"); require("./data.json"); import("./lib/b.mjs");',
    "lib/a.js": 'require("../lib/b.mjs"); require("declared/x"); require("chain/lib");', "lib/b.mjs": 'import "@scope/deep/x"; import "./a.js";', "lib/index.js": 'require("from-lib-index");',
    "vendor/package.json": '{"main":"./entry.cjs"}', "vendor/entry.cjs": 'require("from-vendor");', "vendor/index.js": 'require("vendor-index-not-used");', "data.json": "{}", "lib/unreached.js": 'require("unreached");' });
  const findings = await reachableUndeclaredImports(pkg, files, async (file) => { reads.push(file); return read(file); });
  // Breadth-first from index.js: the witness of a name is the shallowest file that imports it.
  expect(findings).toEqual([{ name: "from-lib-index", file: "lib/index.js" }, { name: "from-vendor", file: "vendor/entry.cjs" }, { name: "@scope/deep", file: "lib/b.mjs" }]);
  expect(reads.sort()).toEqual(["index.js", "lib/a.js", "lib/b.mjs", "lib/index.js", "vendor/entry.cjs", "vendor/package.json"]);
  const broken = memory({ "package.json": "{}", "index.js": 'require("./dir");', "dir/package.json": "not json", "dir/index.mjs": 'import "after-bad-manifest";' });
  expect(await reachableUndeclaredImports({}, broken.files, broken.read)).toEqual([{ name: "after-bad-manifest", file: "dir/index.mjs" }]);
});

test("bin-only packages are scanned from their executables and a shebang does not hide the imports", async () => {
  const pkg = { name: "tool", version: "1.0.0", bin: { tool: "./bin/tool.js" } };
  const { files, read } = memory({ "package.json": JSON.stringify(pkg), "bin/tool.js": '#!/usr/bin/env node\nrequire("../lib/run.js");', "lib/run.js": 'require("yargs");', "index.js": 'require("index-unused");' });
  expect(await reachableUndeclaredImports(pkg, files, read)).toEqual([{ name: "yargs", file: "lib/run.js" }]);
  const single = memory({ "package.json": "{}", "cli.js": 'require("commander");' });
  expect(await reachableUndeclaredImports({ bin: "cli.js" }, single.files, single.read)).toEqual([{ name: "commander", file: "cli.js" }]);
});

test("a package without a resolvable entry point falls back to all JavaScript files except well-known test locations", async () => {
  for (const [file, expected] of [["lib/a.js", false], ["test/a.js", true], ["lib/__tests__/a.js", true], ["spec/x/y.cjs", true], ["bench/a.js", true], ["benchmark/a.js", true], ["browser-test/a.js", true], ["build/cjs/system-test/test.install.js", true], ["test.js", true], ["a.test.js", true], ["a.spec.mjs", true], ["a.bench.cjs", true], ["testing/a.js", false], ["latest.js", false], ["contest.js", false], ["spec.js", true]] as const) expect(testLocation(file), file).toBe(expected);
  const contents = { "package.json": '{"name":"loose","main":"./missing.js"}', "lib/a.js": 'require("from-lib");', "lib/b.js": 'require("from-lib-b");', "test.js": 'require("tape");', "test/basic.js": 'require("tap");', "lib/a.test.js": 'require("jest");', "benchmark/run.js": 'require("benchmark");' };
  const { files, read } = memory(contents);
  expect(await reachableUndeclaredImports({ name: "loose", main: "./missing.js" }, files, read)).toEqual([{ name: "from-lib", file: "lib/a.js" }, { name: "from-lib-b", file: "lib/b.js" }]);
  // The fallback is not used when the default index resolves, and test files are otherwise reachable only through imports.
  const indexed = memory({ ...contents, "index.js": 'require("./lib/a");' });
  expect(await reachableUndeclaredImports({ name: "loose" }, indexed.files, indexed.read)).toEqual([{ name: "from-lib", file: "lib/a.js" }]);
});

test("imports into nested node_modules, outside the package or above the size limit are not followed", async () => {
  const pkg = { name: "outer", version: "1.0.0", main: "index.js" };
  const contents = { "package.json": JSON.stringify(pkg), "index.js": 'require("./node_modules/inner"); require("./node_modules/inner/index.js"); require("../sibling/index.js"); require("/etc/x.js"); require("./big.js"); require("./lib/../../escape.js");', "node_modules/inner/index.js": 'require("bundled-undeclared");', "node_modules/inner/package.json": "{}", "big.js": 'require("from-big");' };
  const { files, read } = memory(contents);
  files.set("big.js", undeclaredImportSizeLimit + 1);
  const reads: string[] = [];
  expect(await reachableUndeclaredImports(pkg, files, async (file) => { reads.push(file); return read(file); })).toEqual([]);
  expect(reads).toEqual(["index.js"]);
  expect(manifestEntryPoints({ exports: { ".": "./node_modules/x/*.js", "./a": "../*.js" } }, ["node_modules/x/a.js", "a.js"])).toEqual([]);
  // Escaping entries are ignored, so the default index applies.
  const escaping = memory({ "index.js": 'require("x")' });
  expect(await reachableUndeclaredImports({ main: "../escape.js", bin: "/abs.js" }, escaping.files, escaping.read)).toEqual([{ name: "x", file: "index.js" }]);
});

test("closure builds ignore shipped tests of a package shaped like isexe", async () => {
  const root = await temporary(); directories.push(root);
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const pkg = join(f.cache, "fixture-msg@1.0.0@@@1");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-msg", version: "1.0.0", main: "index.js" }));
  await writeFile(join(pkg, "index.js"), 'var fs = require("fs"); var core = process.platform === "win32" ? require("./windows.js") : require("./mode.js"); module.exports = "fixture-msg works";\n');
  await writeFile(join(pkg, "mode.js"), 'module.exports = require("fs").statSync;\n');
  await writeFile(join(pkg, "windows.js"), 'module.exports = require("fs").statSync;\n');
  await mkdir(join(pkg, "test"), { recursive: true });
  await writeFile(join(pkg, "test/basic.js"), 'var t = require("tap"); var rimraf = require("rimraf"); var mkdirp = require("mkdirp"); require("../");\n');
  let logs = "";
  await build({ path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure", output: join(root, "out"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
});

test("deps.undeclaredImports defaults to warn and rejects unknown values", async () => {
  const root = await temporary(); directories.push(root);
  expect((await loadProject({ path: await project(join(root, "default")) })).undeclaredImports).toBe("warn");
  expect((await loadProject({ path: await project(join(root, "error"), { bunko: { deps: { undeclaredImports: "error" } } }) })).undeclaredImports).toBe("error");
  await expect(loadProject({ path: await project(join(root, "invalid"), { bunko: { deps: { undeclaredImports: "loud" } } }) })).rejects.toThrow("deps.undeclaredImports must be warn, error or off");
});

test("closure builds warn about undeclared runtime imports once per package and name, fail on error and stay silent when off", async () => {
  const root = await temporary(); directories.push(root);
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const pkg = join(f.cache, "fixture-msg@1.0.0@@@1");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-msg", version: "1.0.0", main: "index.js", module: "lib.mjs" }));
  await writeFile(join(pkg, "index.js"), 'try { require("supports-color") } catch {}\nmodule.exports = require("./lib/impl.js");\n');
  await writeFile(join(pkg, "lib.mjs"), 'import "@scope/undeclared/sub"; import "node:fs"; export * from "fixture-msg";\n');
  await mkdir(join(pkg, "lib"), { recursive: true });
  await writeFile(join(pkg, "lib/impl.js"), 'const color = require("supports-color"); const dyn = require(process.env.NAME); module.exports = "fixture-msg works";\n');
  await writeFile(join(pkg, "lib/notes.txt"), 'require("not-scanned")');
  await writeFile(join(pkg, "test.js"), 'require("tape")(require("./index.js"));\n');
  const options = { path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure" };
  let logs = "";
  await build({ ...options, output: join(root, "warn"), log: (text) => { logs += text; } });
  const lines = logs.split("\n").filter((line) => line.startsWith("BUNKO_UNDECLARED_IMPORT"));
  expect(lines).toEqual([
    'BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "supports-color" without declaring it (index.js); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application\'s dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.',
    'BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "@scope/undeclared" without declaring it (lib.mjs); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application\'s dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.',
  ]);
  const manifest = JSON.parse(await Bun.file(join(f.source, "package.json")).text());
  await writeFile(join(f.source, "package.json"), JSON.stringify({ ...manifest, bunko: { ...manifest.bunko, deps: { undeclaredImports: "error" } } }));
  await expect(build({ ...options, output: join(root, "error") })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT: 2 undeclared runtime import(s)");
  await writeFile(join(f.source, "package.json"), JSON.stringify({ ...manifest, bunko: { ...manifest.bunko, deps: { undeclaredImports: "off" } } }));
  logs = "";
  await build({ ...options, output: join(root, "off"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
});

test("sharedDeps scans the union closure and collapses identical findings across peer contexts", async () => {
  const root = await temporary(); directories.push(root);
  const f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-adapter@1.0.0@@@1/index.js"), 'module.exports=require("fixture-msg"); try { require("undeclared-helper") } catch {}');
  let logs = "";
  await buildTargets({ path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, sharedDeps: true, output: join(root, "out"), log: (text) => { logs += text; } });
  expect(logs.split("\n").filter((line) => line.startsWith("BUNKO_UNDECLARED_IMPORT"))).toEqual(['BUNKO_UNDECLARED_IMPORT fixture-adapter@1.0.0 imports "undeclared-helper" without declaring it (index.js); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application\'s dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.']);
});


test("application externals do not repair an importing package's strict declaration", async () => {
  const root = await temporary(); directories.push(root);
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const manifest = JSON.parse(await Bun.file(join(f.source, "package.json")).text());
  manifest.dependencies["fixture-dev"] = "1.0.0"; delete manifest.devDependencies;
  manifest.bunko.external = ["fixture-msg", "fixture-dev"];
  manifest.bunko.deps = { strategy: "closure", undeclaredImports: "error" };
  const lock = f.lock as any; lock.workspaces[""].dependencies = manifest.dependencies; delete lock.workspaces[""].devDependencies;
  await writeFile(join(f.source, "package.json"), JSON.stringify(manifest));
  await writeFile(join(f.source, "bun.lock"), JSON.stringify(lock));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports = require("fixture-dev");');
  let logs = "";
  await expect(build({ path: f.source, baseLayout: base, output: join(root, "out"), installCache: f.cache, localCache: false, gitMetadata: false, log: (text) => { logs += text; } })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT");
  expect(logs).toContain("strict declaration policy requires fixing the importing package manifest");
  expect(logs).toContain("deps.undeclaredImports=warn");
  expect(logs).not.toContain("cannot resolve it at runtime");
});
