import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { baseLayout, inspectTar, project, readJSON, temporary } from "./helpers.ts";
import type { ImageConfig } from "../packages/oci/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await temporary(); roots.push(root);
  const bunko = { entrypoints: { server: "src/server.ts", worker: "src/worker.ts" }, defaultEntrypoint: "server", args: ["default-argument"], build: { sourcemap: "external" } };
  const source = await project(join(root, "app"), { bunko }, 'import {message} from "./shared"; console.log("server", message, process.argv.slice(2));');
  await writeFile(join(source, "src/worker.ts"), 'import {message} from "./shared"; console.log("worker", message, process.argv.slice(2));');
  await writeFile(join(source, "src/shared.ts"), 'export const message = "shared-output";');
  return { root, source, bunko, base: await baseLayout(join(root, "base")) };
}

test("one image contains named entries, shared chunks, and an overridable default command", async () => {
  const f = await fixture();
  const options = { path: f.source, baseLayout: f.base, gitMetadata: false, cacheDir: join(f.root, "cache") };
  const image = await build({ ...options, output: join(f.root, "out"), verifyDeterministic: true });
  const config = await readJSON<ImageConfig>(image.layout!, image.config);
  expect(config.config?.Entrypoint).toEqual(["/usr/local/bin/bun"]);
  expect(config.config?.Cmd).toEqual(["/app/src/server.js", "default-argument"]);
  expect(image.defaultEntrypoint).toBe("server");
  expect(image.images[0]!.entrypoints).toEqual({ server: "/app/src/server.js", worker: "/app/src/worker.js" });
  const files = await inspectTar(new BlobStore(image.layout!).path(image.layers.find((layer) => layer.kind === "app")!.descriptor.digest));
  expect(files.some((file) => /chunk.*\.js$/.test(file.name))).toBe(true);
  const stage = join(f.root, "runtime");
  for (const file of files) if (file.content !== undefined && file.content !== null) { const path = join(stage, file.name); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, file.content); }
  for (const name of ["server", "worker"]) {
    const process = Bun.spawn([Bun.which("bun")!, join(stage, "app/src", `${name}.js`), "argument"], { stdout: "pipe", stderr: "pipe" });
    const [out, error, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit).toBe(0); expect(error).toBe(""); expect(out).toContain(`${name} shared-output`); expect(out).toContain("argument");
  }
  const cached = await build({ ...options, output: join(f.root, "cached") });
  expect(cached.root).toEqual(image.root);
  expect(cached.images[0]!.entrypoints).toEqual(image.images[0]!.entrypoints);
  await writeFile(join(f.source, "src/worker.ts"), 'console.log("changed-worker");');
  const changed = await build({ ...options, output: join(f.root, "changed") });
  expect(changed.root.digest).not.toBe(image.root.digest);
});

test.each([
  { entrypoints: {}, defaultEntrypoint: "server" },
  { entrypoints: { server: "src/server.ts", worker: "src/worker.ts" } },
  { entrypoints: { server: "src/server.ts" }, defaultEntrypoint: "missing" },
  { entrypoints: { server: "src/server.ts" }, entrypoint: "src/server.ts" },
  { entrypoints: { server: "src/server.ts" }, mode: "compile" },
  { entrypoints: { server: "src/server.ts", alias: "src/server.ts" } },
])("invalid named entry configuration fails before building: %j", async (bunko) => {
  const f = await fixture();
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "fixture", bunko }));
  await expect(loadProject({ path: f.source })).rejects.toThrow();
});

test("ignored secondary entries fail before bundling", async () => {
  const f = await fixture();
  await writeFile(join(f.source, ".bunkoignore"), 'src/worker.ts\n');
  await expect(build({ path: f.source, baseLayout: f.base, output: join(f.root, "out"), localCache: false })).rejects.toThrow("Ignored required input");
});


test("secondary entries cannot be loaded as data", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "src/server.ts"), 'import source from "./worker.ts" with { type: "text" }; console.log(source);');
  await expect(build({ path: f.source, baseLayout: f.base, output: join(f.root, "out"), localCache: false })).rejects.toThrow("An entrypoint cannot also be a data import");
});


test("cached entry maps must match configured names, paths, and the default", async () => {
  const f = await fixture();
  const options = { path: f.source, baseLayout: f.base, gitMetadata: false, cacheDir: join(f.root, "cache") };
  const first = await build({ ...options, output: join(f.root, "first") });
  const key = first.cache.find((item) => item.kind === "app")!.key;
  const path = join(options.cacheDir, "keys/app", `${key.slice(7)}.json`);
  const original = JSON.parse(await readFile(path, "utf8"));
  const maps = [undefined, {}, { server: "src/worker.js", worker: "src/server.js" }, { server: "src/server.js", extra: "src/worker.js" }];
  for (const [i, entrypoints] of maps.entries()) {
    await writeFile(path, JSON.stringify({ ...original, application: { ...original.application, entrypoints } }));
    const rebuilt = await build({ ...options, output: join(f.root, `rebuild-${i}`) });
    expect(rebuilt.cache.some((item) => item.kind === "app" && item.status === "miss")).toBe(true);
    expect(rebuilt.images[0]!.entrypoints).toEqual(first.images[0]!.entrypoints);
    expect(rebuilt.root.digest).toBe(first.root.digest);
  }
});

test.each(["js", "ts", "mjs", "cjs", "mts", "cts", "jsx", "tsx"])("a single named %s entry infers its default and reuses its emitted map", async (extension) => {
  const f = await fixture();
  await writeFile(join(f.source, `src/entry.${extension}`), 'console.log("single-entry");');
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "fixture", bunko: { entrypoints: { single: `./src/entry.${extension}` } } }));
  const options = { path: f.source, baseLayout: f.base, gitMetadata: false, cacheDir: join(f.root, "cache") };
  const first = await build({ ...options, output: join(f.root, "first") });
  const cached = await build({ ...options, output: join(f.root, "cached") });
  expect(first.defaultEntrypoint).toBe("single");
  expect(first.images[0]!.entrypoints).toEqual({ single: "/app/src/entry.js" });
  expect(cached.root.digest).toBe(first.root.digest);
  expect(cached.cache.some((item) => item.kind === "app" && item.status === "local")).toBe(true);
});
