import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../packages/bunko/config.ts";
import { bundle, selectToolchain } from "../packages/bunko/toolchain.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("compile rejects emitted HTML, CSS and client assets before invoking the compiler", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-compile-test-")); directories.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "compile-fixture", module: "index.ts" }));
  await writeFile(join(root, "index.ts"), 'import page from "./index.html"; Bun.serve({routes:{"/":page}});');
  await writeFile(join(root, "index.html"), '<html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./client.ts"></script></body></html>');
  await writeFile(join(root, "style.css"), "body { color: red }");
  await writeFile(join(root, "client.ts"), 'console.log("client");');
  const project = await loadProject({ path: root, mode: "compile" });
  await expect(bundle(project, await selectToolchain(), root, () => {})).rejects.toThrow("Compile mode requires a single JavaScript output");
  expect(await Bun.file(join(root, ".bunko-build/out/bunko-app")).exists()).toBe(false);
});
