import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { assetMappings, stageAssetMappings } from "../packages/bunko/asset-contexts.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await temporary(); roots.push(directory); return directory; }

test.each(["bundle", "source"])("%s assets exclude descendants and normalize file modes without packaging secrets", async (mode) => {
  const directory = await root(), source = await project(join(directory, "source"), { bunko: { assets: ["public"], assetExcludes: ["public/private", "public/*.map"], assetMode: "0444" } });
  await mkdir(join(source, "public/private"), { recursive: true });
  await writeFile(join(source, "public/keep.txt"), "public contents"); await writeFile(join(source, "public/debug.map"), "map"); await writeFile(join(source, "public/private/secret.txt"), "secret");
  await mkdir(join(source, "bunkodata/nested"), { recursive: true });
  await writeFile(join(source, "bunkodata/nested/keep.txt"), "runtime data");
  const metadata = [".DS_Store", "public/.DS_Store", "bunkodata/.DS_Store", "bunkodata/nested/.DS_Store"];
  for (const path of metadata) await writeFile(join(source, path), "Finder metadata");
  const base = await baseLayout(join(directory, "base")), options = { path: source, mode, baseLayout: base, push: false, gitMetadata: false, localCache: false, registryCache: false };
  const result = await build({ ...options, output: join(directory, "image") });
  const store = new BlobStore(result.layout!);
  const entries = (await Promise.all(result.layers.map((layer) => inspectTar(store.path(layer.descriptor.digest))))).flat();
  expect(entries.find((entry) => entry.name === "app/public/keep.txt")!.mode).toBe(0o444);
  expect(entries.some((entry) => /private|debug\.map|\.DS_Store/.test(entry.name))).toBe(false);
  expect(entries.some((entry) => entry.name === "app/bunkodata/nested/keep.txt")).toBe(true);
  for (const path of metadata) await writeFile(join(source, path), "changed Finder metadata");
  await writeFile(join(source, "public/private/secret.txt"), "changed secret");
  const changed = await build({ ...options, output: join(directory, "unchanged") });
  expect(changed.root.digest).toBe(result.root.digest);
});

test("source asset exclusions cannot remove entrypoints or package scopes", async () => {
  const directory = await root(), source = await project(join(directory, "source"), { bunko: { assets: ["src"], assetExcludes: ["src/server.ts"] } });
  await expect(build({ path: source, mode: "source", baseLayout: await baseLayout(join(directory, "base")), push: false, localCache: false, output: join(directory, "image") })).rejects.toThrow("required source input");
});

test("external asset mappings filter relative descendants and retain explicit readonly modes in layer hashes", async () => {
  const directory = await root(), context = join(directory, "context"); await mkdir(join(context, "data/private"), { recursive: true });
  await writeFile(join(context, "data/file.txt"), "content"); await writeFile(join(context, "data/private/secret.txt"), "secret");
  await writeFile(join(context, "data/.DS_Store"), "Finder metadata");
  const mapping = { context: "assets", from: "data", to: "/repo/data", exclude: ["private"], mode: "0444" };
  const readonly = await stageAssetMappings(assetMappings([mapping]), { assets: context }, join(directory, "readonly"));
  expect(readonly.entries.some((entry) => /private|\.DS_Store/.test(entry.path))).toBe(false);
  await writeFile(join(context, "data/.DS_Store"), "changed metadata");
  const repeated = await stageAssetMappings(assetMappings([mapping]), { assets: context }, join(directory, "repeated"));
  expect(repeated.materials[0]!.digest).toBe(readonly.materials[0]!.digest);
  const writable = await stageAssetMappings(assetMappings([{ ...mapping, mode: "0644" }]), { assets: context }, join(directory, "writable"));
  expect(readonly.materials[0]!.digest).not.toBe(writable.materials[0]!.digest);
  const store = new BlobStore(join(directory, "store")), layer = (await packLayer(store, readonly.entries, "assets", 0))!;
  expect((await inspectTar(store.path(layer.descriptor.digest))).find((entry) => entry.name === "repo/data/file.txt")!.mode).toBe(0o444);
  expect(() => assetMappings([{ ...mapping, mode: "4755" }])).toThrow("Asset mode");
  expect(() => assetMappings([{ ...mapping, exclude: ["../escape"] }])).toThrow("archive path");
});

test("source exclusions reject extended tsconfig files discovered after asset selection", async () => {
  const directory = await root(), source = await project(join(directory, "source"), { bunko: { assets: ["config"], assetExcludes: ["config/base.json"] } });
  await mkdir(join(source, "config"));
  await writeFile(join(source, "tsconfig.json"), JSON.stringify({ extends: "./config/base.json" }));
  await writeFile(join(source, "config/base.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }));
  await expect(build({ path: source, mode: "source", baseLayout: await baseLayout(join(directory, "base")), push: false, localCache: false, output: join(directory, "image") })).rejects.toThrow("required source input: config/base.json");
});
