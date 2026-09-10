import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitSourceIgnore, assertNoSourcePrivateKey } from "../packages/bunko/source-policy.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const directory = await temporary(); roots.push(directory); return directory; }
async function file(root: string, path: string, value: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

test("source gitignore honors nested rules, negation, directory patterns and excluded parents without Git", async () => {
  const directory = await root();
  await file(directory, ".gitignore", "secrets/\n*.json\n!package.json\n/root-only\ncache/\n");
  await file(directory, "nested/.gitignore", "!public.json\n");
  await file(directory, "secrets/.gitignore", "!key.json\n");
  const ignored = gitSourceIgnore(directory);
  expect(await ignored("package.json")).toBe(false);
  expect(await ignored("nested/private.json")).toBe(true);
  expect(await ignored("nested/public.json")).toBe(false);
  expect(await ignored("secrets/key.json")).toBe(true);
  expect(await ignored("cache", true)).toBe(true);
  expect(await ignored("cache", false)).toBe(false);
  expect(await ignored("root-only")).toBe(true);
  expect(await ignored("nested/root-only")).toBe(false);
});

test("source images omit gitignored and known credential paths without leaking their bytes", async () => {
  const directory = await root(), source = await project(join(directory, "source"));
  await file(source, ".gitignore", "secrets/\n*.tfstate\ncoverage/\n");
  await file(source, ".bunkoignore", "extra-secret.txt\n");
  for (const path of ["secrets/service-account.json", ".ssh/key", ".kube/config", ".gnupg/key", ".netrc", "id_rsa", "terraform.tfstate", "coverage/report.json", "extra-secret.txt"]) await file(source, path, "PRIVATE_SENTINEL_DO_NOT_PACKAGE");
  await file(source, "docs/public.txt", "public runtime data");
  const output = join(directory, "image");
  const result = await build({ path: source, mode: "source", baseLayout: await baseLayout(join(directory, "base")), output, push: false, localCache: false, gitMetadata: false });
  const store = new BlobStore(output), entries = await inspectTar(store.path(result.layers.find((layer) => layer.kind === "app")!.descriptor.digest));
  expect(JSON.stringify(entries)).not.toContain("PRIVATE_SENTINEL_DO_NOT_PACKAGE");
  expect(entries.some((entry) => entry.name === "app/docs/public.txt")).toBe(true);
});

test("ignored required inputs and private-key markers fail before registry access", async () => {
  const directory = await root(), source = await project(join(directory, "source")); let requests = 0;
  const registry = { fetcher: async () => { requests++; throw new Error("No network expected"); } };
  await file(source, ".gitignore", "src/\n");
  await expect(build({ path: source, mode: "source", push: false, registry, gitMetadata: false })).rejects.toThrow("Git-ignored required source input");
  await file(source, ".gitignore", "");
  const marker = "-----BEGIN " + "PRIVATE KEY-----";
  await file(source, "service-account.json", JSON.stringify({ private_key: marker + "\\nsecret\\n" }));
  await expect(build({ path: source, mode: "source", push: false, registry, gitMetadata: false })).rejects.toThrow("Private-key marker in source input");
  expect(requests).toBe(0);
  const boundary = join(directory, "boundary"); await writeFile(boundary, "x".repeat(65530) + marker);
  await expect(assertNoSourcePrivateKey(boundary, "boundary")).rejects.toThrow("Private-key marker");
});

test("ignore rule files and scopes reject symlinks and bounded-size violations", async () => {
  const directory = await root(), outside = await root(); await file(outside, ".gitignore", "*\n");
  await symlink(join(outside, ".gitignore"), join(directory, ".gitignore"));
  await expect(gitSourceIgnore(directory)("app.ts")).rejects.toThrow("regular file");
  await rm(join(directory, ".gitignore"));
  await symlink(outside, join(directory, "linked"));
  await expect(gitSourceIgnore(directory)("linked/app.ts")).rejects.toThrow("regular directory");
  await file(directory, ".gitignore", "x".repeat(256 * 1024 + 1));
  await expect(gitSourceIgnore(directory)("app.ts")).rejects.toThrow("256 KiB");
});

test.each(["generated/", "generated"])("explicit source assets override %s without including ignored siblings", async (pattern) => {
  const directory = await root(), source = await project(join(directory, "source"));
  await file(source, ".gitignore", pattern + "\n");
  await file(source, "generated/.gitignore", "!other.txt\n");
  await file(source, "generated/dist/build.json", '{"built":true}');
  await file(source, "generated/dist/private.txt", "excluded");
  await file(source, "generated/dist/.DS_Store", "metadata");
  await file(source, "generated/other.txt", "ignored sibling");
  const manifest = await Bun.file(join(source, "package.json")).json();
  await file(source, "package.json", JSON.stringify({ ...manifest, bunko: { assets: ["generated/dist"], assetExcludes: ["generated/dist/private.txt"] } }));
  const result = await build({ path: source, mode: "source", baseLayout: await baseLayout(join(directory, "base")), output: join(directory, "image"), push: false, localCache: false, gitMetadata: false });
  const store = new BlobStore(result.layout!);
  const entries = (await Promise.all(result.layers.map((layer) => inspectTar(store.path(layer.descriptor.digest))))).flat();
  expect(entries.some((entry) => entry.name === "app/generated/dist/build.json")).toBe(true);
  for (const suffix of ["other.txt", "private.txt", ".DS_Store"]) expect(entries.some((entry) => entry.name.endsWith(suffix))).toBe(false);
});

test.each(["runtime/**", "runtime/data.txt"])("explicit asset %s retains authoritative exclusions", async (pattern) => {
  const directory = await root(), source = await project(join(directory, "source"));
  await file(source, "runtime/data.txt", "required data");
  await file(source, ".gitignore", "runtime/\n");
  const manifest = await Bun.file(join(source, "package.json")).json();
  await file(source, "package.json", JSON.stringify({ ...manifest, bunko: { assets: [pattern] } }));
  const options = { path: source, mode: "source" as const, baseLayout: await baseLayout(join(directory, "base")), output: join(directory, "image"), push: false, localCache: false, gitMetadata: false };
  await build(options);
  await rm(options.output, { recursive: true, force: true });
  await file(source, ".bunkoignore", "runtime/data.txt\n");
  await expect(build(options)).rejects.toThrow("Ignored required input");
  await file(source, ".bunkoignore", "");
  await file(source, "runtime/data.txt", "-----BEGIN " + "PRIVATE KEY-----");
  await expect(build(options)).rejects.toThrow("Private-key marker");
});

test("bundle input selection still ignores gitignore", async () => {
  const directory = await root(), source = await project(join(directory, "source"));
  await file(source, ".gitignore", "src/\n");
  const result = await build({ path: source, mode: "bundle", baseLayout: await baseLayout(join(directory, "base")), output: join(directory, "image"), push: false, localCache: false, gitMetadata: false });
  expect(result.layers.some((layer) => layer.kind === "app")).toBe(true);
});

test("explicit ignored assets cannot include credentials, symlinks or build output", async () => {
  const directory = await root(), source = await project(join(directory, "source"));
  await file(source, ".gitignore", "dist/\n");
  await file(source, "dist/.env", "secret");
  const manifest = await Bun.file(join(source, "package.json")).json();
  await file(source, "package.json", JSON.stringify({ ...manifest, bunko: { assets: ["dist"] } }));
  const options = { path: source, mode: "source" as const, push: false, localCache: false, gitMetadata: false };
  await expect(build(options)).rejects.toThrow("Excluded required source input");
  await rm(join(source, "dist/.env"));
  await symlink(join(source, "src/server.ts"), join(source, "dist/link"));
  await expect(build(options)).rejects.toThrow("symlinks");
  await rm(join(source, "dist/link"));
  await expect(build({ ...options, output: join(source, "dist") })).rejects.toThrow("Output/cache exclusion overlaps required source input");
});
