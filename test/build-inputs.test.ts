import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guardedBuild } from "../packages/bunko/bundle-worker.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";
import { build } from "../packages/bunko/build.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await temporary()); dirs.push(root);
  return { root, source: await project(join(root, "app")) };
}
async function run(source: string) {
  return guardedBuild({ root: source, contextRoot: source, entrypoint: "src/server.ts", outdir: join(source, "out"), external: [], minify: false, sourcemap: "none", define: {} });
}

test.each([
  'import { value } from "./macro.ts" with { type: "macro" }; console.log(value());',
  'import { value } from "macro:./macro.ts"; console.log(value());',
  'const {value} = require("macro:./macro.ts"); console.log(value());',
  'export { value } from "./macro.ts" with { type: "macro" };',
  'const mod = await import("./macro.ts", { with: { type: "macro" } }); console.log(mod);',
])("loaded transitive inputs reject macros before execution: %s", async (code) => {
  const { source } = await fixture();
  await writeFile(join(source, "src/server.ts"), 'import "../node_modules/probe/index.ts";');
  await mkdir(join(source, "node_modules/probe"), { recursive: true });
  await writeFile(join(source, "node_modules/probe/index.ts"), code);
  const marker = join(source, "executed");
  await writeFile(join(source, "node_modules/probe/macro.ts"), `await Bun.write(${JSON.stringify(marker)}, "unsafe"); export function value() { return 1; }`);
  const result = await run(source);
  expect(result.success).toBe(false);
  expect(result.logs.map((l) => l.message).join()).toContain("macros are not supported");
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("unloaded modules and copied JS assets do not undergo executable validation", async () => {
  const { root, source } = await fixture();
  await project(source, { bunko: { assets: ["public"] } });
  await mkdir(join(source, "public"), { recursive: true });
  await writeFile(join(source, "public/browser.js"), 'const name = location.hash; import(name);');
  await mkdir(join(source, "unused"));
  await writeFile(join(source, "unused/tsconfig.json"), '{"extends":"missing-mobile-config/base"}');
  await writeFile(join(source, "unused/macro.ts"), 'import x from "macro:missing";');
  const result = await build({ path: source, baseLayout: await baseLayout(join(root, "base")), output: join(root, "image"), gitMetadata: false, localCache: false });
  const asset = result.layers.find((l) => l.kind === "assets")!;
  expect((await inspectTar(new BlobStore(result.layout!).path(asset.descriptor.digest))).some((f) => f.name.endsWith("browser.js"))).toBe(true);
  await writeFile(join(source, "src/server.ts"), 'import "../public/browser.js";');
  await expect(build({ path: source, baseLayout: join(root, "base"), output: join(root, "bad"), localCache: false })).rejects.toThrow("Computed require/import");
});

test("configuration of an imported sibling is still validated", async () => {
  const { source } = await fixture();
  await mkdir(join(source, "sibling"));
  await writeFile(join(source, "sibling/tsconfig.json"), '{"extends":"missing-config/base"}');
  await writeFile(join(source, "sibling/index.ts"), 'export default 1;');
  await writeFile(join(source, "src/server.ts"), 'import n from "../sibling/index.ts"; console.log(n);');
  const result = await run(source);
  expect(result.success).toBe(false);
  expect(result.logs.map((l) => l.message).join()).toContain("relative tsconfig extends");
});

test("data attributes and literal dynamic imports preserve output", async () => {
  const { source } = await fixture();
  await writeFile(join(source, "src/data.txt"), 'this is plain text');
  await writeFile(join(source, "src/value.json"), '{"value":42}');
  await writeFile(join(source, "src/server.ts"), 'import text from "./data.txt" with {type:"text"}; const data = await import("./value.json", {with:{type:"json"}}); console.log(text, data.default.value);');
  const result = await run(source);
  expect(result.success).toBe(true);
  expect(result.metafile?.inputs).toBeDefined();
  const output = await readFile(join(source, "out/src/server.js"), "utf8");
  expect(output).toContain("this is plain text");
  expect(output).toContain("42");
});

test("entry modules reject macros and file/toml data retain native loader behavior", async () => {
  const { source } = await fixture();
  const marker = join(source, "executed");
  await writeFile(join(source, "src/macro.ts"), `await Bun.write(${JSON.stringify(marker)}, "unsafe"); export function value() { return 1; }`);
  await writeFile(join(source, "src/server.ts"), 'import {value} from "./macro.ts" with {type:"macro"}; console.log(value());');
  const rejected = await run(source);
  expect(rejected.success).toBe(false);
  expect(await Bun.file(marker).exists()).toBe(false);
  await writeFile(join(source, "src/data.bin"), Buffer.from([0, 255, 1, 2, 3]));
  await writeFile(join(source, "src/data.toml"), 'answer=42\n');
  await writeFile(join(source, "src/server.ts"), 'import file from "./data.bin" with {type:"file"}; import data from "./data.toml" with {type:"toml"}; console.log(file, data.answer);');
  const result = await run(source);
  expect(result.logs.map((entry) => entry.message)).toEqual([]);
  expect(result.success).toBe(true);
  const binary = result.outputs.find((output) => output.path.endsWith(".bin"));
  expect(binary).toBeDefined();
  expect(new Uint8Array(await binary!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 2, 3]));
});

test("a JavaScript file imported as text stays data and mixed loads fail", async () => {
  const { source } = await fixture();
  const marker = join(source, "executed");
  await writeFile(join(source, "src/data.js"), `import {value} from "./macro.ts" with {type:"macro"}; console.log(value());`);
  await writeFile(join(source, "src/macro.ts"), `await Bun.write(${JSON.stringify(marker)}, "unsafe"); export function value(){ return 1; }`);
  await writeFile(join(source, "src/server.ts"), 'import text from "./data.js" with {type:"text"}; console.log(text);');
  expect((await run(source)).success).toBe(true);
  expect(await Bun.file(marker).exists()).toBe(false);
  await writeFile(join(source, "src/data.js"), 'export default 42;');
  await writeFile(join(source, "src/other.ts"), 'import value from "./data.js"; console.log(value);');
  await writeFile(join(source, "src/server.ts"), 'import text from "./data.js" with {type:"text"}; import "./other.ts"; console.log(text);');
  await expect(run(source)).rejects.toThrow("cannot mix data-loader and ordinary imports");
});


test.each([false, true])("mixed loaders fail regardless of importer discovery order (%s)", async (reverse) => {
  const { source } = await fixture();
  await writeFile(join(source, "src/data.js"), 'export default 42;');
  await writeFile(join(source, "src/ordinary.ts"), 'import value from "./data.js"; console.log(value);');
  await writeFile(join(source, "src/text.ts"), 'import text from "./data.js" with {type:"text"}; console.log(text);');
  const imports = ['import "./ordinary.ts";', 'import "./text.ts";'];
  await writeFile(join(source, "src/server.ts"), (reverse ? imports.reverse() : imports).join("\n"));
  await expect(run(source)).rejects.toThrow("cannot mix data-loader and ordinary imports");
});

test("data inputs cannot escape the context or alias an entrypoint", async () => {
  const { root, source } = await fixture();
  await writeFile(join(root, "outside.txt"), 'outside');
  await writeFile(join(source, "src/server.ts"), 'import text from "../../outside.txt" with {type:"text"}; console.log(text);');
  const outside = await run(source);
  expect(outside.success).toBe(false);
  expect(outside.logs.map((entry) => entry.message).join()).toContain("escaped the project snapshot");
  await writeFile(join(source, "src/server.ts"), 'import text from "./server.ts" with {type:"text"}; console.log(text);');
  const self = await run(source);
  expect(self.success).toBe(false);
  expect(self.logs.map((entry) => entry.message).join()).toContain("entrypoint cannot also be a data import");
});
