import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { rm, realpath, stat } from "node:fs/promises";
import { cacheLocation, cacheLocations } from "../packages/bunko/cache-backend-options.ts";
import { validateCacheOptions } from "../packages/bunko/cache-options.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await realpath(await temporary()); roots.push(root); const source = join(root, "source"); await project(source); return { root, source, base: await baseLayout(join(root, "base")) }; }

test("typed cache locations normalize repositories and reject ambiguous configuration", () => {
  expect(cacheLocation("type=registry,repo=team/cache", "from")).toEqual(cacheLocation("docker.io/team/cache", "from"));
  expect(cacheLocation("type=local,src=./cache", "from").type).toBe("local");
  for (const value of ["type=gha", "type=s3,bucket=cache", "type=local,dest=x", "type=registry,repo=x,repo=y", "type=registry,repo=x:tag", "type=registry,repo=x,mode=max", "type=local,src=", " type=local,src=x"]) expect(() => cacheLocation(value, "from")).toThrow();
  expect(cacheLocations(["team/cache", "docker.io/team/cache"], "from")).toHaveLength(1);
  expect(() => cacheLocations(Array(9).fill("team/cache"), "to")).toThrow();
  expect(() => validateCacheOptions({ cacheTo: ["type=local,dest=cache"], cacheWrite: false })).not.toThrow();
  expect(() => validateCacheOptions({ cacheTo: ["type=local,dest=cache"], localCache: false })).toThrow();
});

test("local exports are reusable without importing the write destination or packaging its contents", async () => {
  const { root, source, base } = await fixture(), exported = join(source, "portable-cache");
  const options = { path: source, baseLayout: base, push: false, gitMetadata: false, registryCache: false, cacheDir: join(root, "managed") };
  const first = await build({ ...options, cacheTo: [`type=local,dest=${exported}`], output: join(root, "first") });
  expect(first.cacheExports!.some((event) => event.backend === "local" && event.status === "written")).toBe(true);
  await rm(options.cacheDir, { recursive: true, force: true });
  const second = await build({ ...options, cacheFrom: [`type=local,src=${exported}`], cacheTo: [`type=local,dest=${exported}`], output: join(root, "second") });
  expect(second.root.digest).toBe(first.root.digest);
  expect(second.cache.some((event) => event.status === "local" && event.source === exported)).toBe(true);
  expect(second.cacheExports!.every((event) => event.status === "already-present")).toBe(true);
  await rm(options.cacheDir, { recursive: true, force: true });
  const writeOnly = await build({ ...options, cacheTo: [`type=local,dest=${exported}`], output: join(root, "third") });
  expect(writeOnly.cache.some((event) => event.status === "miss")).toBe(true);
  expect(writeOnly.root.digest).toBe(first.root.digest);
});

test("ordered mixed sources promote local hits to multiple independent destinations", async () => {
  const { root, source, base } = await fixture(), portable = join(root, "portable"), copy = join(root, "copy");
  const mock = new MockRegistry(), registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const options = { path: source, baseLayout: base, output: join(root, "image"), push: false, gitMetadata: false, registry, cacheDir: join(root, "managed") };
  await build({ ...options, cacheTo: [`type=local,dest=${portable}`] });
  await rm(options.cacheDir, { recursive: true, force: true });
  const result = await build({ ...options, output: join(root, "second"), cacheFrom: ["type=registry,repo=registry.test/missing", `type=local,src=${portable}`], cacheTo: ["type=registry,repo=registry.test/exported", `type=local,dest=${copy}`], cacheExportError: "fail" });
  expect(result.cache.some((event) => event.source === portable)).toBe(true);
  expect(new Set(result.cacheExports!.map((event) => event.backend))).toEqual(new Set(["local", "registry"]));
  expect(result.cacheExports!.every((event) => event.status === "written")).toBe(true);
});

test("invalid local imports fall through and never create missing read directories", async () => {
  const { root, source, base } = await fixture(), missing = join(root, "missing");
  await build({ path: source, baseLayout: base, output: join(root, "image"), push: false, gitMetadata: false, cacheDir: join(root, "managed"), cacheFrom: [`type=local,src=${missing}`] });
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

test("local cache paths cannot overlap source roots, layouts or reports", async () => {
  const { root, source, base } = await fixture();
  for (const path of ["/", source, root, join(root, "image"), join(root, "report.json"), base]) {
    await expect(build({ path: source, baseLayout: base, push: false, output: join(root, "image"), report: join(root, "report.json"), cacheTo: [`type=local,dest=${path}`], gitMetadata: false })).rejects.toThrow();
  }
});

test("offline local imports work and dry runs leave explicit exports untouched", async () => {
  const { root, source, base } = await fixture(), portable = join(root, "portable"), untouched = join(root, "untouched");
  const options = { path: source, baseLayout: base, output: join(root, "image"), push: false, gitMetadata: false, cacheDir: join(root, "managed") };
  const first = await build({ ...options, cacheTo: [`type=local,dest=${portable}`] });
  await rm(options.cacheDir, { recursive: true, force: true });
  const offline = await build({ ...options, output: join(root, "offline"), offline: true, cacheFrom: [`type=local,src=${portable}`] });
  expect(offline.root.digest).toBe(first.root.digest);
  expect(offline.cache.some((event) => event.source === portable)).toBe(true);
  await build({ ...options, output: join(root, "dry"), dryRun: true, cacheTo: [`type=local,dest=${untouched}`] });
  await expect(stat(untouched)).rejects.toMatchObject({ code: "ENOENT" });
});

test("explicit destinations replace implicit image cache writes and all destinations are attempted", async () => {
  const { root, source, base } = await fixture(), mock = new MockRegistry();
  const result = await build({ path: source, baseLayout: base, push: true, repo: "registry.test/images", localCache: false, gitMetadata: false,
    cacheTo: ["type=registry,repo=registry.test/first", "type=registry,repo=registry.test/second"],
    registry: { credentials: async () => undefined, fetcher: mock.fetch } });
  expect(result.cacheExports!.every((event) => ["registry.test/first", "registry.test/second"].includes(event.destination))).toBe(true);
  expect([...mock.manifests.keys()].some((key) => key.startsWith("registry.test/images/") && key.includes("bunko-cache"))).toBe(false);
  const { writeFile, readFile } = await import("node:fs/promises");
  const denied = join(root, "file"), good = join(root, "good"), report = join(root, "failed-report.json"); await writeFile(denied, "not a directory");
  await expect(build({ path: source, baseLayout: base, push: false, output: join(root, "output"), cacheDir: join(root, "managed"), gitMetadata: false, report,
    cacheTo: [`type=local,dest=${denied}`, `type=local,dest=${good}`], cacheExportError: "fail" })).rejects.toThrow("Cache export failed");
  const written = JSON.parse(await readFile(report, "utf8"));
  expect(written.targets[0].cacheExports.some((event: any) => event.destination === good && event.status === "written")).toBe(true);
});

test("managed local hits are not rewritten and disabled exports preserve configured locations", async () => {
  const { root, source, base } = await fixture(), managed = join(root, "managed"), untouched = join(root, "untouched");
  const options = { path: source, baseLayout: base, push: false, gitMetadata: false, cacheDir: managed };
  const first = await build({ ...options, output: join(root, "first") });
  const hit = first.cache.find((entry) => entry.kind === "app")!, metadata = join(managed, "keys", "app", `${hit.key.slice(7)}.json`);
  const { utimes } = await import("node:fs/promises");
  await utimes(metadata, new Date(100000), new Date(100000));
  const before = await stat(metadata);
  const second = await build({ ...options, output: join(root, "second"), cacheTo: [`type=local,dest=${untouched}`], cacheWrite: false });
  expect(second.cache.some((entry) => entry.kind === "app" && entry.status === "local")).toBe(true);
  expect(second.cacheExports).toEqual([]);
  expect((await stat(metadata)).mtimeMs).toBe(before.mtimeMs);
  await expect(stat(untouched)).rejects.toMatchObject({ code: "ENOENT" });
});

test("typed exports retain implicit image-repository reads and strict failure causes", async () => {
  const { root, source, base } = await fixture(), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const options = { path: source, baseLayout: base, push: true, repo: "registry.test/images", localCache: false, gitMetadata: false, registry };
  await build(options);
  const second = await build({ ...options, cacheTo: ["type=registry,repo=registry.test/exported"] });
  expect(second.cache.some((entry) => entry.status === "registry" && entry.source?.startsWith("registry.test/images/"))).toBe(true);
  mock.cacheWritable = false;
  try {
    await build({ ...options, cacheTo: ["type=registry,repo=registry.test/denied"], cacheExportError: "fail" });
    throw new Error("Expected export failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Cache export failed");
    expect((error as Error).cause).toBeInstanceOf(Error);
  }
});

test("existing and dangling leaf symlinks are rejected before cache access or source snapshot", async () => {
  const { root, source, base } = await fixture();
  const { symlink, readFile } = await import("node:fs/promises");
  const manifest = await readFile(join(source, "package.json"), "utf8");
  for (const [name, target] of [["source-link", source], ["base-link", base], ["dangling-link", join(root, "absent")]] as const) {
    const link = join(root, name); await symlink(target, link);
    for (const direction of ["from", "to"] as const) {
      const report = join(root, `${name}-${direction}.json`);
      await expect(build({ path: source, baseLayout: base, push: false, output: join(root, "output"), report, gitMetadata: false,
        ...(direction === "from" ? { cacheFrom: [`type=local,src=${link}`] } : { cacheTo: [`type=local,dest=${link}`] }) })).rejects.toThrow("must not be symbolic links");
      await expect(stat(join(root, "output"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }
  expect(await readFile(join(source, "package.json"), "utf8")).toBe(manifest);
  await expect(stat(join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(source, "keys"))).rejects.toMatchObject({ code: "ENOENT" });
});
