import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { snapshot } from "../packages/bunko/files.ts";
import { targetInputs } from "../packages/bunko/inputs.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { discover } from "../packages/bunko/workspace.ts";
import { build } from "../packages/bunko/build.ts";
import { phase, type ProgressEvent } from "../packages/bunko/progress.ts";
import { baseLayout, project, temporary } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function root() { const path = await temporary(); roots.push(path); return path; }

test("context exclusions preserve identity and reject invalid patterns and missing inputs", async () => {
  const r = await root(), source = await project(join(r, "source"));
  await writeFile(join(source, ".bunkoignore"), "# Root-relative globs\nnotes/**\n");
  await mkdir(join(source, "notes")); await writeFile(join(source, "notes/private.txt"), "one");
  const first = await snapshot(source, join(r, "first"));
  await writeFile(join(source, "notes/private.txt"), "two");
  expect(await snapshot(source, join(r, "second"))).toBe(first);
  await writeFile(join(source, ".bunkoignore"), "!src");
  await expect(snapshot(source, join(r, "invalid"))).rejects.toThrow("pattern");
  await writeFile(join(source, ".bunkoignore"), "src");
  await expect(build({ path: source, baseLayout: await baseLayout(join(r, "base")), push: false, localCache: false })).rejects.toThrow("Ignored required input: src/server.ts");
  await writeFile(join(source, "tsconfig.json"), '{"extends":"./settings.json"}');
  await writeFile(join(source, "settings.json"), '{"compilerOptions":{"target":"ESNext"}}');
  await writeFile(join(source, ".bunkoignore"), "settings.json");
  await expect(build({ path: source, baseLayout: join(r, "base"), push: false, localCache: false })).rejects.toThrow("Ignored required input: settings.json");
  await mkdir(join(source, "public")); await writeFile(join(source, "public/a.txt"), "a"); await writeFile(join(source, "public/b.txt"), "b");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "hello", module: "src/server.ts", bunko: { assets: ["public/*.txt"] } }));
  await writeFile(join(source, ".bunkoignore"), "public/b.txt");
  await expect(build({ path: source, baseLayout: join(r, "base"), push: false, localCache: false })).rejects.toThrow("Ignored required input: public/b.txt");
});

test("member identity tracks relative/workspace imports, modes and conservative aliases", async () => {
  const r = await root(), source = join(r, "source");
  await mkdir(source); await writeFile(join(source, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  for (const name of ["a", "b", "c"]) await project(join(source, "packages", name), { name });
  await writeFile(join(source, "packages/a/src/server.ts"), 'import "../../b/src/server.ts";');
  const found = await discover({ path: join(source, "packages/a") });
  const config = await loadProject({ path: join(source, "packages/a") }, found.workspace);
  const digest = async () => (await targetInputs(source, config, await snapshot(source, join(r, `snapshot-${Math.random()}`)))).digest;
  const first = await digest();
  await writeFile(join(source, "packages/c/src/server.ts"), 'console.log("unrelated");');
  expect(await digest()).toBe(first);
  await writeFile(join(source, "packages/b/src/server.ts"), 'console.log("relevant");');
  const second = await digest(); expect(second).not.toBe(first);
  await chmod(join(source, "packages/b/src/server.ts"), 0o755); expect(await digest()).not.toBe(second);
  await writeFile(join(source, "packages/c/base.json"), '{"compilerOptions":{"jsx":"preserve"}}');
  await writeFile(join(source, "packages/a/tsconfig.json"), '{"extends":"../c/base.json"}');
  const configDigest = await digest();
  await writeFile(join(source, "packages/c/base.json"), '{"compilerOptions":{"jsx":"react-jsx"}}');
  expect(await digest()).not.toBe(configDigest);
  await writeFile(join(source, "tsconfig.json"), '{"compilerOptions":{"paths":{"x":["packages/*"]}}}');
  const full = await snapshot(source, join(r, "full")); expect((await targetInputs(source, config, full)).digest).toBe(full);
});

test("ignored unrelated tsconfigs are not parsed", async () => {
  const r = await root(), source = await project(join(r, "source"));
  await mkdir(join(source, "ignored"));
  await writeFile(join(source, "ignored/tsconfig.json"), "invalid JSON");
  await writeFile(join(source, ".bunkoignore"), "ignored");
  const result = await build({ path: source, baseLayout: await baseLayout(join(r, "base")), push: false, localCache: false, output: join(r, "out") });
  expect(result.root.digest).toMatch(/^sha256:/);
});

test("progress reports ordered completion/failure without serializing errors", async () => {
  const events: ProgressEvent[] = [], emit = (event: ProgressEvent) => { events.push(event); };
  expect(await phase(emit, "snapshot", async () => 42)).toBe(42);
  await expect(phase(emit, "prepare", async () => { throw Error("secret"); }, "service")).rejects.toThrow("secret");
  expect(events.map((e) => e.status)).toEqual(["started", "completed", "started", "failed"]);
  expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0); expect(JSON.stringify(events)).not.toContain("secret");
});

test("an unrelated member edit reuses application bytes while audit identity changes", async () => {
  const r = await root(), source = join(r, "source");
  await mkdir(source); await writeFile(join(source, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  for (const name of ["a", "b"]) await project(join(source, "packages", name), { name });
  await writeFile(join(source, "bun.lock"), JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "root" }, "packages/a": { name: "a" }, "packages/b": { name: "b" } }, packages: { a: ["a@workspace:packages/a"], b: ["b@workspace:packages/b"] } }));
  const options = { path: join(source, "packages/a"), baseLayout: await baseLayout(join(r, "base")), push: false, gitMetadata: false, cacheDir: join(r, "cache") };
  const first = await build({ ...options, output: join(r, "first") });
  await writeFile(join(source, "packages/b/src/server.ts"), 'console.log("unrelated edit");');
  const second = await build({ ...options, output: join(r, "second") });
  expect(second.cache.find((e) => e.kind === "app")!.status).toBe("local");
  expect(second.layers.find((l) => l.kind === "app")!.descriptor).toEqual(first.layers.find((l) => l.kind === "app")!.descriptor);
  expect(second.sourceDigest).not.toBe(first.sourceDigest);
});
