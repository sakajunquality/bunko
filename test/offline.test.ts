import { exportLayouts } from "../packages/oci/layout.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { LayoutSource, resolveBase } from "../packages/oci/source.ts";
import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareBase } from "../packages/bunko/prepare-base.ts";
import { offlineOptions } from "../packages/bunko/offline.ts";
import { build } from "../packages/bunko/build.ts";
import { downloadRuntime } from "../packages/bunko/runtime-download.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { baseLayout, cli, project, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { runImage } from "./run-image.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await temporary(); roots.push(directory); return directory; }

test("prepared bases persist verified complete blobs and support cold offline builds without dependencies", async () => {
  const directory = await root(), input = await baseLayout(join(directory, "original")), output = join(directory, "prepared");
  const prepared = await prepareBase({ baseLayout: input, output, platform: "linux/amd64" });
  expect(prepared.status).toBe("prepared"); expect(prepared.platforms).toHaveLength(1);
  await rm(input, { recursive: true });
  const source = await project(join(directory, "source"));
  const result = await build({ path: source, offline: true, baseLayout: output, output: join(directory, "image"), gitMetadata: false, localCache: false });
  expect(await runImage(result, join(directory, "run"))).toBe("hello bunko");
  await expect(prepareBase({ baseLayout: output, output })).rejects.toThrow("Output already exists");
  const manifest = prepared.platforms[0]!.digest;
  await writeFile(join(output, "blobs/sha256", manifest.slice(7)), "corrupt");
  await expect(build({ path: source, offline: true, baseLayout: output, output: join(directory, "bad"), localCache: false })).rejects.toThrow("mismatch");
});

test("offline dependency builds reuse matching caches and fail before installation on a source cache miss", async () => {
  const directory = await root(), fixture = await dependencyFixture(directory), base = await baseLayout(join(directory, "base"));
  const options = { path: fixture.source, baseLayout: base, push: false, gitMetadata: false, cacheDir: join(directory, "cache"), installCache: fixture.cache, registryCache: false };
  const warm = await build({ ...options, output: join(directory, "warm") });
  await rm(fixture.cache, { recursive: true });
  let requests = 0;
  const offline = await build({ ...options, offline: true, output: join(directory, "offline"), registry: { fetcher: async () => { requests++; throw new Error("unexpected network"); } } });
  expect(offline.root.digest).toBe(warm.root.digest); expect(requests).toBe(0);
  expect(await runImage(offline, join(directory, "run"))).toBe("fixture-msg works");
  await writeFile(join(fixture.source, "src/server.ts"), "console.log('changed')");
  await expect(build({ ...options, offline: true, output: join(directory, "miss") })).rejects.toThrow("Offline dependency installation");
});

test("offline mode rejects remote operations and missing verified runtime cache without fetching", async () => {
  for (const options of [{}, { baseLayout: "base", push: true }, { baseLayout: "base", registryCache: true }, { baseLayout: "base", cacheFrom: ["registry.example/cache"] }, { baseLayout: "base", externalDeps: { "linux/amd64": "registry.example/deps@sha256:" + "a".repeat(64) } }, { baseLayout: "base", signKey: "key" }]) {
    expect(() => offlineOptions({ path: ".", offline: true, ...options })).toThrow("Offline");
  }
  const directory = await root(); let requests = 0;
  await expect(downloadRuntime(await selectToolchain(), { os: "linux", architecture: "amd64" }, { offline: true, cache: join(directory, "runtime"), fetcher: async () => { requests++; throw new Error("unexpected network"); } })).rejects.toThrow("Offline runtime cache");
  expect(requests).toBe(0);
});


test("CLI prepares bases and disables implicit publication for offline builds", async () => {
  const directory = await root(), base = await baseLayout(join(directory, "base")), source = await project(join(directory, "source"));
  const child = Bun.spawn([process.execPath, "packages/bunko/cli.ts", "prepare-base", "--base-layout", base, "--oci-layout", join(directory, "prepared")], { stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0); expect(error).toBe(""); expect(JSON.parse(out).status).toBe("prepared");
  const result = await cli(["build", source, "--offline", "--base-layout", join(directory, "prepared"), "--oci-layout", join(directory, "image")]);
  expect(result.exit).toBe(0); expect(result.stdout).toBe("");
  const bad = await cli(["build", source, "--offline", "--push=true", "--base-layout", base]);
  expect(bad.exit).toBe(1); expect(bad.stderr).toContain("Offline builds cannot publish");
});


test("prepared base layouts inside the project stay outside the source snapshot", async () => {
  const directory = await root(), source = await project(join(directory, "source")), base = await baseLayout(join(source, "prepared-base"));
  const options = { path: source, offline: true, baseLayout: base, localCache: false, gitMetadata: false };
  const first = await build({ ...options, output: join(directory, "first") });
  await writeFile(join(base, "unreferenced-note.txt"), "local base storage is not application source");
  const second = await build({ ...options, output: join(directory, "second") });
  expect(second.sourceDigest).toBe(first.sourceDigest); expect(second.root.digest).toBe(first.root.digest);
});


test("prepare-base deduplicates normalized platform aliases and exports one multi-platform reference", async () => {
  const directory = await root();
  const amd64 = { os: "linux", architecture: "amd64" } as const;
  const arm64 = { os: "linux", architecture: "arm64", variant: "v8" } as const;
  const images = [];
  for (const platform of [amd64, arm64]) {
    const input = await baseLayout(join(directory, platform.architecture), platform);
    const store = new BlobStore(join(directory, `store-${platform.architecture}`));
    const base = await resolveBase(new LayoutSource(input), platform, store);
    images.push({ source: store, root: { ...base.descriptor, platform }, all: [base.manifest.config, ...base.manifest.layers], refName: platform.architecture });
  }
  const input = join(directory, "input"), output = join(directory, "prepared");
  await exportLayouts(input, images);
  const prepared = await prepareBase({ baseLayout: input, output, platform: "linux/arm64,linux/arm64/v8,linux/amd64" });
  expect(prepared.platforms).toHaveLength(2);
  const layout = await Bun.file(join(output, "index.json")).json();
  expect(layout.manifests).toHaveLength(1);
  expect(layout.manifests[0].annotations["org.opencontainers.image.ref.name"]).toMatch(/^bunko\.local\/prepared-base:sha256-/);
  for (const platform of [amd64, arm64]) expect((await resolveBase(new LayoutSource(output), platform, new BlobStore(join(directory, `verify-${platform.architecture}`)))).config.architecture).toBe(platform.architecture);
});
