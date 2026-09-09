import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { bareSpecifierPackage, declaredNames, scannableRuntimeFile, undeclaredImportPolicy, undeclaredImportSizeLimit, undeclaredImports } from "../packages/bunko/undeclared-imports.ts";
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
  await writeFile(join(pkg, "index.js"), 'try { require("supports-color") } catch {}\nmodule.exports = require("./lib/impl.js");\n');
  await writeFile(join(pkg, "lib.mjs"), 'import "@scope/undeclared/sub"; import "node:fs"; export * from "fixture-msg";\n');
  await mkdir(join(pkg, "lib"), { recursive: true });
  await writeFile(join(pkg, "lib/impl.js"), 'const color = require("supports-color"); const dyn = require(process.env.NAME); module.exports = "fixture-msg works";\n');
  await writeFile(join(pkg, "lib/notes.txt"), 'require("not-scanned")');
  const options = { path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache, depsStrategy: "closure" };
  let logs = "";
  await build({ ...options, output: join(root, "warn"), log: (text) => { logs += text; } });
  const lines = logs.split("\n").filter((line) => line.startsWith("BUNKO_UNDECLARED_IMPORT"));
  expect(lines).toEqual([
    'BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "supports-color" without declaring it (index.js); the isolated layout cannot resolve it at runtime. Update the package, or declare it in the application\'s dependencies and bunko.external.',
    'BUNKO_UNDECLARED_IMPORT fixture-msg@1.0.0 imports "@scope/undeclared" without declaring it (lib.mjs); the isolated layout cannot resolve it at runtime. Update the package, or declare it in the application\'s dependencies and bunko.external.',
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
  expect(logs.split("\n").filter((line) => line.startsWith("BUNKO_UNDECLARED_IMPORT"))).toEqual(['BUNKO_UNDECLARED_IMPORT fixture-adapter@1.0.0 imports "undeclared-helper" without declaring it (index.js); the isolated layout cannot resolve it at runtime. Update the package, or declare it in the application\'s dependencies and bunko.external.']);
});
