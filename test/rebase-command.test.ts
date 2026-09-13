import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { rebase, readRebasePolicy } from "../packages/bunko/rebase.ts";
import { exportMetadata } from "../packages/bunko/metadata.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../packages/oci/source.ts";
import { exportLayout } from "../packages/oci/layout.ts";
import { pushLayout } from "../packages/bunko/push-layout.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { media, type ImageConfig } from "../packages/oci/types.ts";
import { project, temporary, readJSON } from "./helpers.ts";
import { rebaseBase } from "./rebase-fixture.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await temporary(); directories.push(root);
  const old = await rebaseBase(join(root, "old"));
  const fresh = await rebaseBase(join(root, "fresh"), undefined, { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "FLAG=new"] });
  const source = await project(join(root, "source"));
  const built = await build({ path: source, baseLayout: old.directory, output: join(root, "image"), localCache: false, registryCache: false, gitMetadata: false, sbom: true, provenance: true });
  await rm(source, { recursive: true });
  return { root, old, fresh, built, options: { image: `layout:${built.layout}`, oldBase: `layout:${old.directory}`, base: `layout:${fresh.directory}` } };
}

test("rebase exports and rebases again without application source or process execution", async () => {
  const f = await fixture();
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Rebase attempted to execute a process"); });
  try {
    const result = await rebase({ ...f.options, output: join(f.root, "rebased"), sbom: true, provenance: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.platforms[0]!.preservedLayers).toEqual(f.built.layers.map((l) => l.descriptor.digest));
    const config = await readJSON<ImageConfig>(result.layout!, result.platforms[0]!.config);
    expect(config.config?.Env).toContain("FLAG=new");
    expect(config.config?.User).toBe("65532:65532");
    const second = await rebase({ ...f.options, image: `layout:${result.layout}`, oldBase: f.options.base, base: f.options.oldBase, output: join(f.root, "again"), sbom: true, provenance: true });
    expect(second.platforms[0]!.preservedLayers).toEqual(result.platforms[0]!.preservedLayers);
    const inventory = await exportMetadata(`layout:${result.layout}`, join(f.root, "metadata"));
    expect(inventory.records).toHaveLength(2);
    for (const item of inventory.records) {
      const doc = JSON.parse(await readFile(join(inventory.directory, item.file), "utf8"));
      if (item.payload.mediaType === "application/spdx+json") expect(doc.packages[0].versionInfo).toBe(result.platforms[0]!.manifest.digest);
      else { expect(doc.predicate.buildDefinition.buildType).toEndWith("/rebase/v1"); expect(doc.subject[0].digest.sha256).toBe(result.root.digest.slice(7)); }
    }
    expect(result.signed).toBe(false);
  } finally { spawn.mockRestore(); }
});

test("dry-run reports the same planned digest without exports or registry writes", async () => {
  const f = await fixture(), remote = new MockRegistry();
  const common = { ...f.options, repo: "registry.example/rebased", tags: ["test"], registry: { fetcher: remote.fetch, credentials: async () => undefined } };
  const plan = await rebase({ ...common, dryRun: true, output: join(f.root, "absent"), report: join(f.root, "report.json") });
  expect(remote.requests.every((request) => ["GET", "HEAD"].includes(request.method))).toBe(true);
  expect(await Bun.file(join(f.root, "absent", "index.json")).exists()).toBe(false);
  const published = await rebase({ ...common, report: join(f.root, "report.json") });
  expect(published.publication?.published).toBe(true);
  expect(published.root.digest).toBe(plan.root.digest);
});

test("unsafe configuration, legacy metadata and unpinned inputs fail before publishing", async () => {
  const f = await fixture(), remote = new MockRegistry();
  const changed = await rebaseBase(join(f.root, "changed"), undefined, { User: "1000" });
  const common = { ...f.options, repo: "registry.example/rebased", registry: { fetcher: remote.fetch, credentials: async () => undefined } };
  await expect(rebase({ ...common, base: `layout:${changed.directory}` })).rejects.toThrow("User");
  expect(remote.requests).toHaveLength(0);
  await expect(rebase({ ...common, image: f.options.oldBase })).rejects.toThrow("capsule");
  await expect(rebase({ ...common, image: "registry.example/app:latest" })).rejects.toThrow("digest-pinned");
  await expect(rebase({ ...f.options, dryRun: true, report: join(f.old.directory, "report.json") })).rejects.toThrow("overlaps");
});

test("policy parsing is bounded, rejects unknown fields and requires exact digests", async () => {
  const root = await temporary(); directories.push(root); const path = join(root, "policy.json");
  const transition = { platform: "linux/amd64", libc: "glibc", oldBase: `sha256:${"a".repeat(64)}`, newBase: `sha256:${"b".repeat(64)}` } as const;
  await writeFile(path, canonicalJSON({ schemaVersion: 1, transitions: [transition] }));
  expect((await readRebasePolicy(path)).value.transitions).toEqual([transition]);
  await writeFile(path, canonicalJSON({ schemaVersion: 1, transitions: [transition], force: true }));
  await expect(readRebasePolicy(path)).rejects.toThrow("policy");
  await writeFile(path, " ".repeat(65_537));
  await expect(readRebasePolicy(path)).rejects.toThrow("64 KiB");
});

test("all source platforms are planned before publication and missing replacements are rejected", async () => {
  const root = await temporary(); directories.push(root);
  async function combined(name: string, badArm = false) {
    const store = new BlobStore(join(root, `${name}-store`)), manifests = [], descriptors = [];
    for (const architecture of ["amd64", "arm64"] as const) {
      const platform = { os: "linux", architecture } as const;
      const base = await rebaseBase(join(root, `${name}-${architecture}`), platform, badArm && architecture === "arm64" ? { User: "1000" } : {});
      const image = await resolveBase(new LayoutSource(base.directory), platform, store);
      manifests.push({ ...image.descriptor, platform }); descriptors.push(image.descriptor, image.manifest.config, ...image.manifest.layers);
    }
    const index = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests }), media.index), output = join(root, name);
    await exportLayout(store, output, index, descriptors, name);
    return output;
  }
  const old = await combined("old"), fresh = await combined("fresh"), bad = await combined("bad", true);
  const source = await project(join(root, "app"));
  const built = await build({ path: source, baseLayout: old, output: join(root, "built"), platform: "linux/amd64,linux/arm64", localCache: false, registryCache: false, gitMetadata: false });
  const remote = new MockRegistry();
  const options = { image: `layout:${built.layout}`, oldBase: `layout:${old}`, base: `layout:${bad}`, repo: "registry.example/multi", registry: { fetcher: remote.fetch, credentials: async () => undefined } };
  await expect(rebase({ ...options, output: join(root, "absent") })).rejects.toThrow("User");
  expect(remote.requests).toHaveLength(0);
  expect(await Bun.file(join(root, "absent/index.json")).exists()).toBe(false);
  const result = await rebase({ ...options, base: `layout:${fresh}` });
  expect(result.platforms.map((item) => item.platform.architecture)).toEqual(["amd64", "arm64"]);
  expect(result.publication?.published).toBe(true);
});

test("authenticated inputs, immutable tags and explicit signing use the new subjects", async () => {
  const f = await fixture(), remote = new MockRegistry();
  let challenges = 0;
  const registry = { credentials: async () => ({ username: "test", password: "fixture-only" }), fetcher: async (url: string | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get("Authorization") !== `Basic ${Buffer.from("test:fixture-only").toString("base64")}`) { challenges++; return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="rebase-test"' } }); }
    if (remote.failTag && init?.method === "PUT" && new URL(url).pathname.endsWith(`/manifests/${remote.failTag}`)) return Response.json({ errors: [{ code: "TAG_INVALID", message: "repository is immutable" }] }, { status: 400 });
    return remote.fetch(url, init);
  } };
  const original = await pushLayout(f.built.layout!, "registry.example/input", [], registry);
  const old = await pushLayout(f.old.directory, "registry.example/old", [], registry);
  const fresh = await pushLayout(f.fresh.directory, "registry.example/new", [], registry);
  // Registry sources must preserve the original base root identity, not a layout wrapper.
  const base = new RegistrySource(old.reference, registry), platform = { os: "linux", architecture: "amd64" } as const;
  const resolved = await resolveBase(base, platform, new BlobStore(join(f.root, "remote-base")));
  const remoteSource = await project(join(f.root, "remote-app"));
  const remoteBuilt = await build({ path: remoteSource, base: old.reference, repo: "registry.example/app", bare: true, push: true, registry, localCache: false, registryCache: false, gitMetadata: false, sbom: true });
  const log = join(f.root, "sign.jsonl"), helper = join(f.root, "cosign");
  await writeFile(helper, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='version') console.log(JSON.stringify({gitVersion:'v3.1.3'})); else appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\n`); await chmod(helper, 0o755);
  const result = await rebase({ image: remoteBuilt.publication!.reference, oldBase: old.reference, base: fresh.reference, repo: "registry.example/out", registry, signKey: "fixture-key", cosignPath: helper, sbom: true, provenance: true });
  expect(result.signed).toBe(true); expect(challenges).toBeGreaterThan(0);
  const signed = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(signed.every((args) => args.includes("--tlog-upload=false") && args.at(-1) !== original.reference)).toBe(true);
  expect(signed.some((args) => args.at(-1).endsWith(`@${result.root.digest}`))).toBe(true);
  expect(result.platforms[0]!.oldBase).toBe(resolved.descriptor.digest);
  remote.manifests.set("registry.example/out/locked", { bytes: canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [] }), type: media.index });
  remote.failTag = "locked";
  const options = { image: remoteBuilt.publication!.reference, oldBase: old.reference, base: fresh.reference, repo: "registry.example/out", registry, tags: ["locked"] };
  await expect(rebase(options)).rejects.toThrow();
  const skipped = await rebase({ ...options, tagConflict: "skip" });
  expect(skipped.publication?.skippedTags?.map((item) => item.tag)).toEqual(["locked"]);
});
