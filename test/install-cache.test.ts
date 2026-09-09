import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installCachePath } from "../packages/bunko/install-cache.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";

const roots: string[] = [];
const previous = process.env.XDG_CACHE_HOME;
afterEach(async () => {
  if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("the Bun download cache defaults to a persistent directory beside the layer cache unless local caching is disabled", async () => {
  const root = await temporary(); roots.push(root);
  // Cache paths are canonical: existing ancestors are resolved through symlinks.
  const canonical = await realpath(root);
  process.env.XDG_CACHE_HOME = join(root, "xdg");
  expect(await installCachePath({})).toBe(join(canonical, "xdg", "bunko", "install", "v1"));
  expect(await installCachePath({ cacheDir: join(root, "layers") } as Parameters<typeof installCachePath>[0])).toBe(join(canonical, "xdg", "bunko", "install", "v1"));
  expect(await installCachePath({ localCache: false })).toBeUndefined();
  expect(await installCachePath({ installCache: "relative-cache" })).toBe(join(await realpath(process.cwd()), "relative-cache"));
  expect(await installCachePath({ installCache: join(root, "explicit"), localCache: false })).toBe(join(canonical, "explicit"));
  delete process.env.XDG_CACHE_HOME;
  expect(await installCachePath({})).toBe(join(await realpath(homedir()), ".cache", "bunko", "install", "v1"));
});

test("builds install from the default download cache and keep it out of the snapshot", async () => {
  const root = await temporary(); roots.push(root);
  process.env.XDG_CACHE_HOME = join(root, "xdg");
  const fixture = await dependencyFixture(root), base = await baseLayout(join(root, "base"));
  const cache = join(root, "xdg", "bunko", "install", "v1");
  await mkdir(join(root, "xdg", "bunko", "install"), { recursive: true });
  // The prepared fixture cache stands in for packages downloaded by an earlier build.
  await cp(fixture.cache, cache, { recursive: true });
  const result = await build({ path: fixture.source, baseLayout: base, output: join(root, "out"), cacheDir: join(root, "layers"), gitMetadata: false });
  expect(result.images[0]!.inventory.map((pkg) => pkg.name)).toEqual(["fixture-msg"]);
  expect((await readdir(cache)).sort()).toEqual(["fixture-dev@1.0.0@@@1", "fixture-msg@1.0.0@@@1"]);
});
