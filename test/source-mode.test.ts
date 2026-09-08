import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type BuildResult } from "../packages/bunko/build.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
import { command } from "./command.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await temporary(); roots.push(directory); return directory; }
async function run(result: BuildResult, directory: string) {
  await mkdir(directory);
  const store = new BlobStore(result.layout!);
  await command(["python3", "-c", "import sys,tarfile\nfor p in sys.argv[2:]:\n with tarfile.open(p) as t:t.extractall(sys.argv[1],filter='data')", directory, ...result.layers.map((layer) => store.path(layer.descriptor.digest))]);
  const config = JSON.parse(Buffer.from(await store.read(result.config)).toString()).config;
  const args = [...config.Entrypoint.slice(1), ...config.Cmd].map((value: string) => value.startsWith("/") ? join(directory, value) : value);
  const child = Bun.spawn([process.execPath, ...args], { cwd: join(directory, config.WorkingDir), env: { PATH: process.env.PATH!, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(error);
  return out.trim();
}

test("source mode preserves module locations, dynamic imports, package scope and data without bundling", async () => {
  const directory = await root(), source = await project(join(directory, "source"), {}, 'const module = await import("./" + "task.ts"); console.log(module.message, (await Bun.file(new URL("data.txt", import.meta.url)).text()).trim());');
  await writeFile(join(source, "src/task.ts"), 'export const message = "source task";');
  await writeFile(join(source, "src/data.txt"), "preserved data\n");
  await writeFile(join(source, ".env"), "PRIVATE=never-package");
  const base = await baseLayout(join(directory, "base"));
  const options = { path: source, mode: "source", baseLayout: base, push: false, gitMetadata: false, cacheDir: join(directory, "cache"), registryCache: false };
  const result = await build({ ...options, output: join(directory, "image") });
  expect(await run(result, join(directory, "run"))).toBe("source task preserved data");
  expect(await Bun.file(join(directory, "run/app/.env")).exists()).toBe(false);
  expect(await readFile(join(directory, "run/app/src/server.ts"), "utf8")).toContain('import("./"');
  const warm = await build({ ...options, output: join(directory, "warm") });
  expect(warm.root.digest).toBe(result.root.digest); expect(warm.cache.find((item) => item.kind === "app")!.status).toBe("local");
  await writeFile(join(source, "src/data.txt"), "changed data");
  expect((await build({ ...options, output: join(directory, "changed") })).root.digest).not.toBe(result.root.digest);
});

test("source mode automatically packages production dependencies and omits development dependencies", async () => {
  const directory = await root(), fixture = await dependencyFixture(directory, false), base = await baseLayout(join(directory, "base"));
  const result = await build({ path: fixture.source, mode: "source", baseLayout: base, push: false, gitMetadata: false, localCache: false, registryCache: false, installCache: fixture.cache, output: join(directory, "image") });
  expect(await run(result, join(directory, "run"))).toBe("fixture-msg works");
  expect(result.images[0]!.inventory.map((item) => item.name)).toContain("fixture-msg");
  expect(result.images[0]!.inventory.map((item) => item.name)).not.toContain("fixture-dev");
});

test("workspace source mode retains source paths and isolated peer dependency topology", async () => {
  const directory = await root(), fixture = await workspaceFixture(directory), base = await baseLayout(join(directory, "base"));
  for (const name of ["api", "worker"]) {
    const file = join(fixture.source, "services", name, "package.json");
    const manifest = JSON.parse(await readFile(file, "utf8")); delete manifest.bunko.build; await writeFile(file, JSON.stringify(manifest));
  }
  for (const [name, version] of [["api", "one"], ["worker", "two"]]) {
    const result = await build({ path: join(fixture.source, "services", name!), mode: "source", baseLayout: base, push: false, gitMetadata: false, localCache: false, registryCache: false, installCache: fixture.cache, output: join(directory, name!) });
    expect(await run(result, join(directory, `run-${name}`))).toBe(`${name} shared ${version} ${version}`);
  }
});

test("source mode refuses ignored bundler settings and supports unmodified named entry paths", async () => {
  const directory = await root(), source = await project(join(directory, "source"));
  await expect(loadProject({ path: source, mode: "source", define: { BUILD: "true" } })).rejects.toThrow("bundler build settings");
  await expect(loadProject({ path: source, mode: "source", depsStrategy: "closure" })).rejects.toThrow("production dependencies");
  await writeFile(join(source, "src/task.ts"), 'console.log("task")');
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "named-source", bunko: { mode: "source", entrypoints: { server: "src/server.ts", task: "src/task.ts" }, defaultEntrypoint: "server" } }));
  const result = await build({ path: source, baseLayout: await baseLayout(join(directory, "base")), push: false, localCache: false, output: join(directory, "image") });
  expect(result.images[0]!.entrypoints).toEqual({ server: "/app/src/server.ts", task: "/app/src/task.ts" });
  expect(await run(result, join(directory, "run"))).toBe("hello bunko");
});
