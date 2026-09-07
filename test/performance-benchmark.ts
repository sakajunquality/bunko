import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyntaxCache } from "../packages/bunko/syntax-cache.ts";
import { rejectMacros } from "../packages/bunko/files.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";

const directory = resolve(process.argv[2] ?? "node_modules");
const files = (await Array.fromAsync(new Bun.Glob("**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scan({ cwd: directory, dot: true, followSymlinks: false }))).sort();
const cache = new SyntaxCache(), scanMs: { mode: string; milliseconds: number }[] = [];
for (const mode of ["uncached", "memoized-first", "memoized-repeat"]) {
  const start = performance.now();
  for (const file of files) await rejectMacros(join(directory, file), file, mode === "uncached" ? undefined : cache);
  scanMs.push({ mode, milliseconds: performance.now() - start });
}
const root = await mkdtemp(join(tmpdir(), "bunko-performance-"));
try {
  const f = await dependencyFixture(root), base = await baseLayout(join(root, "base")), builds = [];
  for (const name of ["cold", "warm"]) {
    const start = performance.now();
    const result = await build({ path: f.source, baseLayout: base, output: join(root, name), push: false, gitMetadata: false, cacheDir: join(root, "cache"), installCache: f.cache });
    builds.push({ name, milliseconds: performance.now() - start, root: result.root.digest, cache: result.cache });
  }
  if (builds[0]!.root !== builds[1]!.root) throw new Error("Cached build changed image identity");
  console.log(JSON.stringify({ bun: Bun.version, os: process.platform, architecture: process.arch, files: files.length, scanMs, validation: cache.stats, fixtureBuilds: builds }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
