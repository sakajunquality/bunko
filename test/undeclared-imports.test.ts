import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { acknowledgedImportSummaryLimit, bareSpecifierPackage, candidateRuntimeFile, cookedLiteral, declaredNames, guardedImports, importSpecifiers, manifestEntryPoints, reachableUndeclaredImports, scanGuards, scannableRuntimeFile, testLocation, undeclaredImportLimit, undeclaredImportPolicy, undeclaredImportSizeLimit, undeclaredImports } from "../packages/bunko/undeclared-imports.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";

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
  expect(undeclaredImportPolicy([{ undeclaredImports: "error" }, { undeclaredImports: "strict" }])).toBe("strict");
  expect(undeclaredImportPolicy([{ undeclaredImports: "strict" }, { undeclaredImports: "warn" }])).toBe("strict");
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
  expect((await loadProject({ path: await project(join(root, "strict"), { bunko: { deps: { undeclaredImports: "strict" } } }) })).undeclaredImports).toBe("strict");
  await expect(loadProject({ path: await project(join(root, "invalid"), { bunko: { deps: { undeclaredImports: "loud" } } }) })).rejects.toThrow("deps.undeclaredImports must be warn, error, strict or off");
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
    'BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "supports-color" without declaring it (lib/impl.js); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application\'s dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.',
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
  await writeFile(join(f.cache, "fixture-adapter@1.0.0@@@1/index.js"), 'module.exports=require("fixture-msg"); require("undeclared-helper");');
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


test("multiple exports patterns retain all Map iterator entries", async () => {
  const manifest = { exports: { "./a/*": "./a/*.js", "./b/*": "./b/*.js" } };
  const { files, read } = memory({ "a/one.js": 'require("missing-a")', "b/two.js": 'require("missing-b")' });
  expect(manifestEntryPoints(manifest, files.keys())).toEqual(["a/one.js", "b/two.js"]);
  expect(await reachableUndeclaredImports(manifest, files, read)).toEqual([{ name: "missing-a", file: "a/one.js" }, { name: "missing-b", file: "b/two.js" }]);
});

test("oversized nested manifests are not read during directory resolution", async () => {
  const { files, read } = memory({ "index.js": 'require("./lib")', "lib/package.json": '{"main":"unused.js"}', "lib/index.js": 'require("missing")' });
  files.set("lib/package.json", undeclaredImportSizeLimit + 1);
  expect(await reachableUndeclaredImports({}, files, async (file) => { expect(file).not.toBe("lib/package.json"); return read(file); })).toEqual([{ name: "missing", file: "lib/index.js" }]);
});


test("repeated stars in an exports target use the same substitution", async () => {
  const manifest = { exports: { "./*": "./lib/*/copy-*.js" } };
  const { files, read } = memory({ "lib/a/copy-a.js": 'require("missing-a")', "lib/a/copy-b.js": 'require("not-exported")' });
  expect(manifestEntryPoints(manifest, files.keys())).toEqual(["lib/a/copy-a.js"]);
  expect(await reachableUndeclaredImports(manifest, files, read)).toEqual([{ name: "missing-a", file: "lib/a/copy-a.js" }]);
});

test("only try-wrapped requires, dynamic imports and require.resolve probes are guarded", () => {
  const all = (...names: string[]) => new Set(names);
  // Shaped like debug@4.4.3 src/node.js.
  expect([...guardedImports('try {\n  const supportsColor = require("supports-color");\n  if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) exports.colors = [20];\n} catch (error) { /* swallowed */ }\n', all("supports-color"))]).toEqual(["supports-color"]);
  expect([...guardedImports('try { const m = await import("dynamic-optional"); } catch {}', all("dynamic-optional"))]).toEqual(["dynamic-optional"]);
  expect([...guardedImports('module.exports = require.resolve("optional-plugin/package.json");', all("optional-plugin"))]).toEqual(["optional-plugin"]);
  // A require inside a function body, or one that only some occurrence guards, is not guarded.
  expect([...guardedImports('function load() { return require("lazy-dep"); }', all("lazy-dep"))]).toEqual([]);
  expect([...guardedImports('try { require("supports-color"); } catch {}\nconst color = require("supports-color");', all("supports-color"))]).toEqual([]);
  expect([...guardedImports('try { require("subpath/deep"); } catch {}\nrequire("subpath");', all("subpath"))]).toEqual([]);
  // A catch or finally handler is not a guarded position: @babel/core@7.27.7 requires @babel/preset-typescript/package.json from one.
  expect([...guardedImports('try { compile(); } catch (error) { const pkg = require("@babel/preset-typescript/package.json"); throw error; }', all("@babel/preset-typescript"))]).toEqual([]);
  expect([...guardedImports('try { compile(); } finally { require("cleanup-dep"); }', all("cleanup-dep"))]).toEqual([]);
  // Every literal naming a candidate counts, so a computed require next to a plain mention of the name keeps it reported.
  expect([...guardedImports('const name = "supports-color"; require(name);', all("supports-color"))]).toEqual([]);
  expect([...guardedImports('try { require("guarded") } catch {}', all("guarded", "never-mentioned"))]).toEqual(["guarded"]);
});

test("static import and export sources are never guarded, even next to try blocks", () => {
  const code = 'import color from "supports-color";\nexport * from "@scope/re-exported";\ntry { require("supports-color"); require("@scope/re-exported"); } catch {}\n';
  expect([...guardedImports(code, new Set(["supports-color", "@scope/re-exported"]))]).toEqual([]);
  expect([...guardedImports('import("guarded-only");', new Set(["guarded-only"]))]).toEqual([]);
});

test("braces in strings, template literals, regex literals and comments do not confuse the try matcher", () => {
  const code = 'const brace = "}{", other = \'{\';\nconst tpl = `${"}"}${`inner ${ "{" } end`}`;\nconst re = /[}{]\\/x/g, div = brace.length / 2 / 1;\n// } { unbalanced in a line comment\n/* } { unbalanced in a block comment */\ntry { require("guarded-one"); } catch (error) { }\nrequire("plain-one");\n';
  expect([...guardedImports(code, new Set(["guarded-one", "plain-one"]))]).toEqual(["guarded-one"]);
  // Nested try blocks at any depth still guard.
  expect([...guardedImports('try { if (a) { for (;;) { try { require("deep"); } catch {} } } } catch {}', new Set(["deep"]))]).toEqual(["deep"]);
  // An unsure pass guards nothing: unbalanced braces, an unterminated comment or string, or template substitutions nested too deeply.
  expect([...guardedImports('function f() { try { require("x"); } catch {}', new Set(["x"]))]).toEqual([]);
  expect([...guardedImports('try { require("x"); } catch {} /* unterminated', new Set(["x"]))]).toEqual([]);
  const nested = (depth: number) => 'try { require("x"); } catch {} const t = ' + "`${".repeat(depth) + "}`".repeat(depth) + ";";
  expect([...guardedImports(nested(8), new Set(["x"]))]).toEqual(["x"]);
  expect([...guardedImports(nested(9), new Set(["x"]))]).toEqual([]);
});

test("a name is optional only when every reached file guards it", async () => {
  const pkg = { name: "debug-like", version: "4.4.3", main: "src/node.js" };
  // src/node.js probes like debug, lib/module-types.js like @babel/core, and gce.js requires plainly like the real finding.
  const { files, read } = memory({ "package.json": JSON.stringify(pkg),
    "src/node.js": 'try { module.exports.colors = require("supports-color").level; } catch (error) { /* optional */ }\nrequire("./module-types.js"); require("./gce.js");',
    "src/module-types.js": 'let ts;\ntry { ts = require("@babel/preset-typescript"); } catch { ts = require.resolve("@babel/preset-typescript"); }\nmodule.exports = ts;',
    "src/gce.js": 'const api = require("@opentelemetry/api");\ntry { require("supports-color"); } catch {}\nmodule.exports = api;' });
  expect(await reachableUndeclaredImports(pkg, files, read)).toEqual([
    { name: "supports-color", file: "src/node.js", optional: true },
    { name: "@babel/preset-typescript", file: "src/module-types.js", optional: true },
    { name: "@opentelemetry/api", file: "src/gce.js" },
  ]);
  // One unguarded use anywhere in the instance moves the witness to that file and drops the optional flag.
  const mixed = memory({ "package.json": JSON.stringify(pkg), "src/node.js": 'try { require("supports-color"); } catch {}\nrequire("./gce.js");', "src/gce.js": 'module.exports = require("supports-color");' });
  expect(await reachableUndeclaredImports(pkg, mixed.files, mixed.read)).toEqual([{ name: "supports-color", file: "src/gce.js" }]);
});

test("optional probes stay silent under warn and error but are reported and fatal under strict", async () => {
  const root = await temporary(); directories.push(root);
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const pkg = join(f.cache, "fixture-msg@1.0.0@@@1");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-msg", version: "1.0.0", main: "index.js" }));
  await writeFile(join(pkg, "index.js"), 'try { require("supports-color"); } catch (error) { /* optional */ }\nfunction hasTypeScript() { try { require("@babel/preset-typescript"); return true; } catch { return false; } }\nmodule.exports = hasTypeScript() ? "fixture-msg works" : "fixture-msg works";\n');
  const options = { path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure" };
  let logs = "";
  await build({ ...options, output: join(root, "warn"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(logs).not.toContain("BUNKO_OPTIONAL_IMPORT");
  const manifest = JSON.parse(await Bun.file(join(f.source, "package.json")).text());
  // A closure whose only findings are optional passes the error policy, which is the point of the classification.
  await writeFile(join(f.source, "package.json"), JSON.stringify({ ...manifest, bunko: { ...manifest.bunko, deps: { undeclaredImports: "error" } } }));
  logs = "";
  await build({ ...options, output: join(root, "error"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(logs).not.toContain("BUNKO_OPTIONAL_IMPORT");
  await writeFile(join(f.source, "package.json"), JSON.stringify({ ...manifest, bunko: { ...manifest.bunko, deps: { undeclaredImports: "strict" } } }));
  logs = "";
  await expect(build({ ...options, output: join(root, "strict"), log: (text) => { logs += text; } })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT: 2 undeclared runtime import(s)");
  expect(logs.split("\n").filter((line) => line.startsWith("BUNKO_OPTIONAL_IMPORT"))).toEqual([
    'BUNKO_OPTIONAL_IMPORT fixture-msg@1.0.0 imports "@babel/preset-typescript" only inside try/catch (index.js); treated as optional',
    'BUNKO_OPTIONAL_IMPORT fixture-msg@1.0.0 imports "supports-color" only inside try/catch (index.js); treated as optional',
  ]);
});

test("call forms are read from significant tokens, not from the raw text before the literal", () => {
  const one = new Set(["x"]);
  const after = (code: string) => [...guardedImports(`try { require("x"); } catch {}\n${code}`, one)];
  // Comments and long runs of whitespace between require( and its argument must not hide the second occurrence.
  expect(after('require(/* lazily */ "x");')).toEqual([]);
  expect(after(`require(${" ".repeat(70)}"x");`)).toEqual([]);
  expect(after('require(\n  // the optional implementation\n  "x",\n);')).toEqual([]);
  expect(after('const m = await import(\n  "x"\n);')).toEqual([]);
  // A member call is not the require this pass can reason about, so the occurrence keeps the name reported.
  expect(after('foo.require("x");')).toEqual([]);
  expect(after('foo.require.resolve("x");')).toEqual([]);
  expect(after('(0, require)("x");')).toEqual([]);
  expect(after('console.log("x");')).toEqual([]);
});

test("literal arguments are decoded before they are matched", () => {
  const one = new Set(["x"]);
  const after = (code: string) => [...guardedImports(`try { require("x"); } catch {}\n${code}`, one)];
  expect(after("require(`x`);")).toEqual([]);
  expect(after('require("\\x78");')).toEqual([]);
  expect(after('require("\\u0078/sub");')).toEqual([]);
  expect(after('require("\\u{78}");')).toEqual([]);
  expect(after(`require("x/${"a".repeat(220)}");`)).toEqual([]);
  expect(after('require("x\\\n");')).toEqual([]);
  // A substitution-free template argument inside a try block is guarded like a string, and escaped delimiters do not end a literal early.
  expect([...guardedImports("try { require(`x`); } catch {}", one)]).toEqual(["x"]);
  expect([...guardedImports('try { require("x"); } catch {}\nconsole.log("a\\"b", `c\\`d`);', one)]).toEqual(["x"]);
  // An escape this pass does not decode could name any candidate, so it abandons the file.
  expect([...guardedImports('try { require("x"); } catch {}\nconst legacy = "\\101";', one)]).toEqual([]);
  expect([...guardedImports('try { require("x"); } catch {}\nconst malformed = "\\xZZ";', one)]).toEqual([]);
  expect(cookedLiteral('a\\x78\\u0079\\u{7a}\\n\\\nb')).toBe("axyz\nb");
  expect(cookedLiteral("\\101")).toBeUndefined();
});

test("an ambiguous slash abandons the file instead of guessing between division and a regular expression", () => {
  const one = new Set(["x"]), guard = 'try { require("x"); } catch {}\n';
  // Reading this division as a regular expression would swallow the unguarded require in it.
  expect([...guardedImports(`${guard}const v = {} / require("x") / 2;`, one)]).toEqual([]);
  // Reading this regular expression as division would open a try scope over the statements after it.
  expect([...guardedImports('if (ok) /try {/.test(s); require("x"); /}/.test(s);', one)]).toEqual([]);
  // A word spelling a keyword after a dot is a property name, a contextual keyword may be a value, and a numeric literal is one token.
  expect([...guardedImports(`${guard}obj.if() / require("x") / 2;`, one)]).toEqual([]);
  expect([...guardedImports(`${guard}obj.return / require("x") / 2;`, one)]).toEqual([]);
  expect([...guardedImports(`${guard}const of = 1; of / require("x") / 2;`, one)]).toEqual([]);
  for (const literal of ["1.", "1.e5", "0x1f", "10n", "1_000", ".5", "0b1010", "0o17"]) expect([...guardedImports(`${guard}${literal} / require("x") / 2;`, one)], literal).toEqual([]);
  // Identifiers are tokenised whole, non-ASCII and escaped ones included, so their spelling cannot leak into the slash context.
  expect([...guardedImports(`${guard}π / require("x") / 2;`, one)]).toEqual([]);
  expect([...guardedImports(`${guard}const caféreturn = 1; caféreturn / require("x") / 2;`, one)]).toEqual([]);
  expect([...guardedImports(`${guard}\\u0072equire / require("x") / 2;`, one)]).toEqual([]);
  // A non-ASCII identifier that ends in a keyword must not open a try scope, and an escaped identifier is not a call form.
  expect([...guardedImports(`${guard}class πtry { load() { require("x"); } }`, one)]).toEqual([]);
  expect([...guardedImports(`${guard}\\u0072equire("x");`, one)]).toEqual([]);
  // Anything else non-ASCII outside a literal, comment or regular expression abandons the file.
  expect([...guardedImports(`${guard}const a = b ✓ c;`, one)]).toEqual([]);
  // Unicode identifiers still lex where the reading is unambiguous.
  expect([...guardedImports('const π = 1; try { require("x"); } catch {}\nif (π) /re/.test(s);', one)]).toEqual(["x"]);
  // A line terminator between a value and a slash can be an inserted semicolon.
  expect([...guardedImports(`${guard}const n = count\n/re/.test(s);`, one)]).toEqual([]);
  // Unambiguous readings still lex: a control header is followed by a statement, any other parenthesis and a subscript by an operator.
  expect([...guardedImports(`${guard}if (a) /re/.test(b);\nwhile (b) /re/.test(c);\nconst half = (a + b) / 2, m = list[0] / 3, r = /[/{]/g, q = 1.5 / 2;`, one)]).toEqual(["x"]);
});

test("line comments end at every line terminator", () => {
  const one = new Set(["x"]), guard = 'try { require("x"); } catch {}\n';
  for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) expect([...guardedImports(`${guard}// note${terminator}require("x");`, one)], JSON.stringify(terminator)).toEqual([]);
  expect([...guardedImports(`${guard}// note require("x");`, one)]).toEqual(["x"]);
});

test("guarding follows lexical try scopes, and only a catch handler protects one", () => {
  const one = new Set(["x"]);
  expect([...guardedImports('try { require("x"); } finally { done(); }', one)]).toEqual([]);
  expect([...guardedImports('try { try { require("x"); } finally { done(); } } catch {}', one)]).toEqual(["x"]);
  expect([...guardedImports('try { attempt(); } catch (error) { require("x"); }', one)]).toEqual([]);
  expect([...guardedImports('try { try { attempt(); } catch (error) { require("x"); } } catch {}', one)]).toEqual(["x"]);
  // Blocks that are not try blocks never guard, whatever encloses them.
  expect([...guardedImports('outer: { require("x"); }', one)]).toEqual([]);
  expect([...guardedImports('class A { load() { return require("x"); } }', one)]).toEqual([]);
  expect([...guardedImports('const load = () => require("x");', one)]).toEqual([]);
  // Requires inside template substitutions, nested one inside another.
  expect([...guardedImports('try { const s = `a${ `b${ require("x") }c` }d`; } catch {}', one)]).toEqual(["x"]);
  expect([...guardedImports('try { require("x"); } catch {}\nconst s = `a${ require("x") }b`;', one)]).toEqual([]);
  // Execution order is not modelled: a require a try block only defers still counts as guarded.
  expect([...guardedImports('try { const f = () => require("x"); } catch {}', one)]).toEqual(["x"]);
});

test("the pass abandons a file it cannot lex with certainty", () => {
  const one = new Set(["x"]), guard = 'try { require("x"); } catch {}\n';
  for (const tail of ['const s = "oops;', "const s = `oops;", "/* oops", "const r = /oops;", "function f() {", "}", "const t = (1;", "1);"])
    expect([...guardedImports(guard + tail, one)], tail).toEqual([]);
});

test("candidates are collected package-wide, so any file can unguard a name another file only probes", async () => {
  const pkg = { name: "cross", version: "1.0.0", main: "index.js" };
  const probe = 'try { require("x"); } catch {}\n', computed = 'const name = "x"; module.exports = require(name);';
  // The specifier scan reports nothing for a computed require, so only the literal mention in the second file keeps the name reported.
  const first = memory({ "package.json": JSON.stringify(pkg), "index.js": `${probe}require("./other.js");`, "other.js": computed });
  expect(await reachableUndeclaredImports(pkg, first.files, first.read)).toEqual([{ name: "x", file: "other.js" }]);
  // The visit order must not matter.
  const second = memory({ "package.json": JSON.stringify(pkg), "index.js": `require("./other.js");\n${probe}`, "other.js": computed });
  expect(await reachableUndeclaredImports(pkg, second.files, second.read)).toEqual([{ name: "x", file: "other.js" }]);
  // Bun's scanner reads an escaped identifier, so no textual prefilter may decide a file has no specifiers.
  expect(importSpecifiers('\\u0072equire("escaped-dep");')).toEqual(["escaped-dep"]);
  const escaped = memory({ "package.json": JSON.stringify(pkg), "index.js": `${probe}require("./other.js");`, "other.js": '\\u0072equire("x");' });
  expect(await reachableUndeclaredImports(pkg, escaped.files, escaped.read)).toEqual([{ name: "x", file: "other.js" }]);
  // A file the pass cannot lex leaves the instance uncertain, and nothing in it stays optional.
  const unsure = memory({ "package.json": JSON.stringify(pkg), "index.js": `${probe}require("./other.js");`, "other.js": 'const legacy = "\\101"; module.exports = 1;' });
  expect(await reachableUndeclaredImports(pkg, unsure.files, unsure.read)).toEqual([{ name: "x", file: "index.js" }]);
});

test("a reached file the pass cannot lex or read leaves the instance uncertain", async () => {
  const pkg = { name: "oversized", version: "1.0.0", main: "index.js" };
  const big = memory({ "package.json": JSON.stringify(pkg), "index.js": 'try { require("x"); } catch {}\nrequire("./other.js");', "other.js": 'require("x");' });
  big.files.set("other.js", undeclaredImportSizeLimit + 1);
  const reads: string[] = [];
  // The oversized file is never read, and it still stops the instance from calling anything optional.
  expect(await reachableUndeclaredImports(pkg, big.files, async (file) => { reads.push(file); return big.read(file); })).toEqual([{ name: "x", file: "index.js" }]);
  expect(reads).toEqual(["index.js"]);
  expect(scanGuards("a".repeat(undeclaredImportSizeLimit + 1), new Set(["x"])).certain).toBe(false);
  expect(scanGuards('try { require("x"); } catch {}', new Set(["x"])).certain).toBe(true);
  // A reader that fails is not an error either: the scan is advisory, so the instance is only left uncertain.
  const denied = memory({ "package.json": JSON.stringify(pkg), "index.js": 'try { require("x"); } catch {}\nrequire("./other.js");', "other.js": 'require("x");' });
  expect(await reachableUndeclaredImports(pkg, denied.files, async (file) => {
    if (file === "other.js") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return denied.read(file);
  })).toEqual([{ name: "x", file: "index.js" }]);
});

test("a reached file that cannot hold an occurrence is never lexed, so only files mentioning a candidate can leave doubt", async () => {
  // Without a backslash a literal's cooked value is its raw text, so a file holding neither the name nor a backslash cannot name it.
  expect(scanGuards("const a = b ✓ c;", new Set(["x"])).certain).toBe(true);
  expect(scanGuards('const a = b ✓ c; const name = "x";', new Set(["x"])).certain).toBe(false);
  const pkg = { name: "quiet", version: "1.0.0", main: "index.js" };
  const probe = 'try { require("x"); } catch {}\nrequire("./other.js");';
  const silent = memory({ "package.json": JSON.stringify(pkg), "index.js": probe, "other.js": "const a = b ✓ c;" });
  expect(await reachableUndeclaredImports(pkg, silent.files, silent.read)).toEqual([{ name: "x", file: "index.js", optional: true }]);
  const mentions = memory({ "package.json": JSON.stringify(pkg), "index.js": probe, "other.js": 'const a = b ✓ c; const name = "x";' });
  expect(await reachableUndeclaredImports(pkg, mentions.files, mentions.read)).toEqual([{ name: "x", file: "index.js" }]);
});

test("the retained-text budget is charged in bytes, so a wide instance reads again instead of holding everything", async () => {
  const pkg = { name: "wide", version: "1.0.0", main: "index.js" };
  // Two 3 MiB files: the first fits the 8 MiB budget as UTF-16 storage, the second does not and is read once more by the second pass.
  const filler = `// ${"a".repeat(3 * 1024 * 1024)}\nconst value = 1;`;
  const wide = memory({ "package.json": JSON.stringify(pkg), "index.js": 'try { require("x"); } catch {}\nrequire("./one.js"); require("./two.js");', "one.js": filler, "two.js": filler });
  const reads: string[] = [];
  expect(await reachableUndeclaredImports(pkg, wide.files, async (file) => { reads.push(file); return wide.read(file); })).toEqual([{ name: "x", file: "index.js", optional: true }]);
  expect(reads.filter((file) => file === "one.js")).toEqual(["one.js"]);
  expect(reads.filter((file) => file === "two.js")).toEqual(["two.js", "two.js"]);
});


test("comment scanning does not share line-terminator cursor state with whitespace checks", () => {
  const guard = 'try { require("x"); } catch {}\n// previous line comment\n';
  for (const gap of ["/*\n*/", "\u2028", "\u2029"])
    expect(scanGuards(`${guard}const n = count ${gap}/re/.test(s);`, new Set(["x"])).certain).toBe(false);
});

test("reading a package manifest does not prevent optional classification", async () => {
  const pkg = { main: "index.js" };
  const input = memory({ "index.js": 'require("./package.json"); try { require("x"); } catch {}', "package.json": JSON.stringify(pkg) });
  expect(await reachableUndeclaredImports(pkg, input.files, input.read)).toEqual([{ name: "x", file: "index.js", optional: true }]);
});

test("deps.acknowledgedImports normalises valid entries and rejects malformed ones", async () => {
  const root = await temporary(); directories.push(root);
  const at = async (name: string, acknowledgedImports: unknown) => loadProject({ path: await project(join(root, name), { bunko: { deps: { acknowledgedImports } } }) });
  expect((await loadProject({ path: await project(join(root, "absent")) })).acknowledgedImports).toEqual([]);
  // Entries are sorted by package, name and version, and unset optional fields are dropped rather than stored as undefined.
  expect((await at("valid", [
    { package: "grpc-gcp", name: "protobufjs" },
    { package: "@babel/core", name: "@babel/preset-typescript", version: "7.27.7" },
    { package: "@babel/core", name: "@babel/preset-typescript", reason: "optional TS preset probed at runtime" },
  ])).acknowledgedImports).toEqual([
    { package: "@babel/core", name: "@babel/preset-typescript", reason: "optional TS preset probed at runtime" },
    { package: "@babel/core", name: "@babel/preset-typescript", version: "7.27.7" },
    { package: "grpc-gcp", name: "protobufjs" },
  ]);
  await expect(at("not-array", { package: "a", name: "b" })).rejects.toThrow("deps.acknowledgedImports must be an array of {package, name} entries");
  await expect(at("not-object", ["@babel/core"])).rejects.toThrow("deps.acknowledgedImports[0] must be an object");
  await expect(at("subpath", [{ package: "@babel/core/lib", name: "x" }])).rejects.toThrow("deps.acknowledgedImports[0].package must be an exact package name");
  await expect(at("missing-package", [{ name: "x" }])).rejects.toThrow("deps.acknowledgedImports[0].package must be an exact package name");
  await expect(at("missing-name", [{ package: "@babel/core" }])).rejects.toThrow("deps.acknowledgedImports[0].name must be an exact package name");
  await expect(at("name-subpath", [{ package: "@babel/core", name: "@babel/preset-typescript/package.json" }])).rejects.toThrow("deps.acknowledgedImports[0].name must be an exact package name");
  // A pinned entry names one resolved version, so every range form is a configuration error rather than a silent near-match.
  for (const version of ["^1.0.0", "~1.0.0", ">=1.0.0", "*", "1.0", "latest", "^1.0.0 || 2", ""]) {
    await expect(at(`range-${version || "empty"}`, [{ package: "a", name: "b" }, { package: "a", name: "b", version }])).rejects.toThrow("deps.acknowledgedImports[1].version must be an exact version string");
  }
  expect((await at("versions", ["1.0.0", "1.0.0-beta.1", "1.0.0+build.5"].map((version) => ({ package: "a", name: "b", version })))).acknowledgedImports)
    .toEqual([{ package: "a", name: "b", version: "1.0.0" }, { package: "a", name: "b", version: "1.0.0+build.5" }, { package: "a", name: "b", version: "1.0.0-beta.1" }]);
  await expect(at("reason", [{ package: "a", name: "b", reason: 7 }])).rejects.toThrow("deps.acknowledgedImports[0].reason must be a string");
  await expect(at("unknown-key", [{ package: "a", name: "b", why: "typo" }])).rejects.toThrow("Unsupported deps.acknowledgedImports[0] setting: why");
  await expect(at("duplicate", [{ package: "a", name: "b", reason: "first" }, { package: "a", name: "b" }])).rejects.toThrow("deps.acknowledgedImports has a duplicate entry for a -> b");
  await expect(at("duplicate-pinned", [{ package: "a", name: "b", version: "1.0.0" }, { package: "a", name: "b", version: "1.0.0" }])).rejects.toThrow("deps.acknowledgedImports has a duplicate entry for a@1.0.0 -> b");
});

/** Writes the target's bunko.deps block and returns the shared closure build options. */
async function acknowledgementFixture(root: string, index: string) {
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), index);
  const manifest = JSON.parse(await Bun.file(join(f.source, "package.json")).text());
  const deps = (extra: Record<string, unknown>) => writeFile(join(f.source, "package.json"), JSON.stringify({ ...manifest, bunko: { ...manifest.bunko, deps: { strategy: "closure", ...extra } } }));
  return { f, deps, options: { path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure" as const } };
}

test("an acknowledged undeclared import stops being reported and stops failing the error policy", async () => {
  const root = await temporary(); directories.push(root);
  const { deps, options } = await acknowledgementFixture(root, 'module.exports="fixture-msg works";require("@babel/preset-typescript");\n');
  await deps({ undeclaredImports: "error" });
  await expect(build({ ...options, output: join(root, "error") })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT: 1 undeclared runtime import(s)");
  await deps({ undeclaredImports: "error", acknowledgedImports: [{ package: "fixture-msg", name: "@babel/preset-typescript", reason: "optional TS preset probed at runtime" }] });
  let logs = "";
  await build({ ...options, output: join(root, "acknowledged"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(logs).not.toContain("BUNKO_UNUSED_ACKNOWLEDGEMENT");
  expect(logs.split("\n")).toContain("Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> @babel/preset-typescript");
});

test("a pinned acknowledgement matches only the importer version it names", async () => {
  const root = await temporary(); directories.push(root);
  const { deps, options } = await acknowledgementFixture(root, 'module.exports="fixture-msg works";require("@babel/preset-typescript");\n');
  await deps({ undeclaredImports: "error", acknowledgedImports: [{ package: "fixture-msg", name: "@babel/preset-typescript", version: "9.9.9" }] });
  let logs = "";
  await expect(build({ ...options, output: join(root, "mismatch"), log: (text) => { logs += text; } })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT: 1 undeclared runtime import(s)");
  expect(logs).toContain('BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "@babel/preset-typescript"');
  expect(logs).toContain("BUNKO_UNUSED_ACKNOWLEDGEMENT deps.acknowledgedImports: fixture-msg@9.9.9 -> @babel/preset-typescript matched no finding");
  await deps({ undeclaredImports: "error", acknowledgedImports: [{ package: "fixture-msg", name: "@babel/preset-typescript", version: "1.0.0" }] });
  logs = "";
  await build({ ...options, output: join(root, "pinned"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(logs).toContain("Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> @babel/preset-typescript");
});

test("an optional finding is acknowledged the same way under strict", async () => {
  const root = await temporary(); directories.push(root);
  const { deps, options } = await acknowledgementFixture(root, 'module.exports="fixture-msg works";try{require("@babel/preset-typescript")}catch{}\n');
  await deps({ undeclaredImports: "strict" });
  await expect(build({ ...options, output: join(root, "strict") })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT: 1 undeclared runtime import(s)");
  await deps({ undeclaredImports: "strict", acknowledgedImports: [{ package: "fixture-msg", name: "@babel/preset-typescript" }] });
  let logs = "";
  await build({ ...options, output: join(root, "acknowledged"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_OPTIONAL_IMPORT");
  expect(logs).toContain("Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> @babel/preset-typescript");
});

test("an acknowledgement that matches no finding is reported as stale without failing, and is skipped when the scan is off", async () => {
  const root = await temporary(); directories.push(root);
  const { deps, options } = await acknowledgementFixture(root, 'module.exports="fixture-msg works";\n');
  await deps({ undeclaredImports: "error", acknowledgedImports: [{ package: "fixture-msg", name: "@babel/preset-typescript", reason: "fixed upstream" }] });
  let logs = "";
  await build({ ...options, output: join(root, "stale"), log: (text) => { logs += text; } });
  expect(logs.split("\n")).toContain("BUNKO_UNUSED_ACKNOWLEDGEMENT deps.acknowledgedImports: fixture-msg -> @babel/preset-typescript matched no finding");
  expect(logs).not.toContain("Acknowledged");
  await deps({ undeclaredImports: "off", acknowledgedImports: [{ package: "fixture-msg", name: "@babel/preset-typescript" }] });
  logs = "";
  await build({ ...options, output: join(root, "off"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNUSED_ACKNOWLEDGEMENT");
});

test("targets sharing a closure contribute the union of their acknowledgements, summarised once per closure", async () => {
  const root = await temporary(); directories.push(root);
  const f = await workspaceFixture(root), base = await baseLayout(join(root, "base"));
  await writeFile(join(f.cache, "fixture-msg@1.0.0@@@1/index.js"), 'module.exports="one";require("x");');
  await writeFile(join(f.source, "package.json"), canonicalJSON({ ...f.manifests[""], bunko: { sharedDeps: true } }));
  // Only the worker acknowledges the finding, while the api is the target whose error policy governs the shared closure.
  await writeFile(join(f.source, "services/api/package.json"), canonicalJSON({ ...f.manifests["services/api"], bunko: { ...f.manifests["services/api"]!.bunko as object, deps: { undeclaredImports: "error" } } }));
  await writeFile(join(f.source, "services/worker/package.json"), canonicalJSON({ ...f.manifests["services/worker"], bunko: { ...f.manifests["services/worker"]!.bunko as object, deps: { acknowledgedImports: [{ package: "fixture-msg", name: "x", reason: "probed at runtime" }] } } }));
  const options = { path: f.source, baseLayout: base, push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache };
  const acknowledged = (logs: string) => logs.split("\n").filter((line) => line.startsWith("Acknowledged "));
  let cold = "";
  expect(await buildTargets({ ...options, output: join(root, "cold"), log: (text) => { cold += text; } })).toHaveLength(2);
  expect(cold).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(acknowledged(cold)).toEqual(["Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> x"]);
  // The replayed plan carries the same findings, so the union filters them exactly once again.
  let warm = "";
  await buildTargets({ ...options, output: join(root, "warm"), log: (text) => { warm += text; } });
  expect(warm).toContain("Reusing dependency closure");
  expect(warm).not.toContain("BUNKO_UNDECLARED_IMPORT");
  expect(acknowledged(warm)).toEqual(["Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> x"]);
}, 30_000);

test("a broad and a pinned entry covering one finding are both used and summarised once", async () => {
  const root = await temporary(); directories.push(root);
  const { deps, options } = await acknowledgementFixture(root, 'module.exports="fixture-msg works";require("x");\n');
  await deps({ undeclaredImports: "error", acknowledgedImports: [{ package: "fixture-msg", name: "x" }, { package: "fixture-msg", name: "x", version: "1.0.0" }] });
  let logs = "";
  await build({ ...options, output: join(root, "overlapping"), log: (text) => { logs += text; } });
  expect(logs).not.toContain("BUNKO_UNDECLARED_IMPORT");
  // A broad entry must not make the pinned one it overlaps look stale: both matched the same finding.
  expect(logs).not.toContain("BUNKO_UNUSED_ACKNOWLEDGEMENT");
  expect(logs.split("\n").filter((line) => line.startsWith("Acknowledged "))).toEqual(["Acknowledged 1 undeclared import(s): fixture-msg@1.0.0 -> x"]);
});

test("acknowledgement is applied before the 100-line budget, so the remaining findings are all logged and counted", async () => {
  const root = await temporary(); directories.push(root);
  const names = Array.from({ length: 101 }, (_, index) => `dep-${String(index).padStart(3, "0")}`);
  const index = `module.exports="fixture-msg works";${names.map((name) => `require(${JSON.stringify(name)});`).join("")}try{require("optional-x")}catch{}\n`;
  const { deps, options } = await acknowledgementFixture(root, index);
  await deps({ undeclaredImports: "strict", acknowledgedImports: names.slice(0, undeclaredImportLimit).map((name) => ({ package: "fixture-msg", name })) });
  let logs = "";
  await expect(build({ ...options, output: join(root, "budget"), log: (text) => { logs += text; } })).rejects.toThrow("BUNKO_UNDECLARED_IMPORT: 2 undeclared runtime import(s)");
  expect(logs.split("\n").filter((line) => line.startsWith("BUNKO_UNDECLARED_IMPORT")))
    .toEqual([`BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "dep-100" without declaring it (index.js); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application's dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.`]);
  expect(logs.split("\n").filter((line) => line.startsWith("BUNKO_OPTIONAL_IMPORT")))
    .toEqual(['BUNKO_OPTIONAL_IMPORT fixture-msg@1.0.0 imports "optional-x" only inside try/catch (index.js); treated as optional']);
  expect(logs).not.toContain("additional warnings omitted");
  expect(logs.split("\n").filter((line) => line.startsWith("Acknowledged ")))
    .toEqual([`Acknowledged 100 undeclared import(s): ${names.slice(0, acknowledgedImportSummaryLimit).map((name) => `fixture-msg@1.0.0 -> ${name}`).join(", ")} and 95 more`]);
}, 30_000);
