import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageConfig, type ImageOptions } from "../packages/oci/image.ts";
import { rebaseMetadata, type RebaseBuildContext } from "../packages/oci/rebase-metadata.ts";
import { inspectRebase, rebaseImage } from "../packages/oci/rebase.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { media, type BaseImage, type Layer } from "../packages/oci/types.ts";

const d = (n: string) => sha256(n);
const context: RebaseBuildContext = { mode: "bundle", libc: "glibc", bunVersion: "1.4.0", bunRevision: "abcdef123", runtimeOrigin: "injected" };
const options: ImageOptions = { platform: { os: "linux", architecture: "amd64" }, epoch: 10, entrypoint: ["/bun"], args: ["app.js"], workdir: "/app", env: { FLAG: "on" }, labels: { team: "one", "org.bunko.mode": "bundle", "org.bunko.runtime.libc": "glibc", "org.bunko.bun.version": "1.4.0", "org.bunko.bun.revision": "abcdef123" }, ports: [] };
const base = (id: string): BaseImage => ({ descriptor: { mediaType: media.manifest, digest: d(id), size: 1 }, manifest: { schemaVersion: 2, mediaType: media.manifest, config: { mediaType: media.config, digest: d(`${id}c`), size: 1 }, layers: [{ mediaType: media.tar, digest: d(`${id}l`), size: 1 }] }, config: { os: "linux", architecture: "amd64", rootfs: { type: "layers", diff_ids: [d(`${id}d`)] }, config: { Env: ["FLAG=base"], User: "1000", Entrypoint: ["/sh"], Cmd: [], WorkingDir: "/", Labels: { base: "yes" } } } });
const layer: Layer = { kind: "runtime", descriptor: { mediaType: media.tar, digest: d("e"), size: 1 }, diffId: d("f") };
function built(old = base("a")) {
  const config = imageConfig(old.config, [layer], options);
  config.config!.Labels!["org.bunko.rebase.metadata"] = rebaseMetadata(old, [layer], options, context);
  return { descriptor: { mediaType: media.manifest, digest: d("i"), size: 1 }, manifest: { schemaVersion: 2 as const, mediaType: media.manifest, config: { mediaType: media.config, digest: d("ic"), size: 1 }, layers: [...old.manifest.layers, layer.descriptor] }, config } as BaseImage;
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function resolved(store: BlobStore, result: { manifest: ReturnType<typeof d> extends never ? never : any; config: any }, indexDigest?: `sha256:${string}`): Promise<BaseImage> {
  const manifest = JSON.parse(Buffer.from(await store.read(result.manifest)).toString("utf8"));
  const config = JSON.parse(Buffer.from(await store.read(result.config)).toString("utf8"));
  return { descriptor: result.manifest, manifest, config, ...(indexDigest ? { indexDigest } : {}) };
}

test("inspects equal-valued explicit environment and empty ports", () => {
  const result = inspectRebase(built(), base("a"));
  expect(result.options.env).toEqual({ FLAG: "on" });
  expect(result.options.ports).toEqual([]);
  expect(result.layers.map((l) => l.kind)).toEqual(["runtime"]);
});

test("rejects altered capsule, old base, and generated layer boundary", () => {
  const image = built();
  expect(() => inspectRebase({ ...image, config: { ...image.config, config: { ...image.config.config, Labels: { ...image.config.config!.Labels, "org.bunko.rebase.metadata": image.config.config!.Labels!["org.bunko.rebase.metadata"]!.replace('"version":1', '"version":2') } } } }, base("a"))).toThrow();
  expect(() => inspectRebase(image, base("b"))).toThrow();
  expect(() => inspectRebase({ ...image, manifest: { ...image.manifest, layers: image.manifest.layers.slice(0, 1) } }, base("a"))).toThrow();
});

test("rebaseImage writes a new manifest and refreshes base identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunko-rebase-")); dirs.push(dir);
  const store = new BlobStore(dir); const result = await rebaseImage(store, built(), base("a"), base("n"));
  expect(result.manifest.digest).toMatch(/^sha256:/);
  expect(result.root).toEqual(result.manifest);
  const manifest = JSON.parse(Buffer.from(await store.read(result.manifest)).toString("utf8"));
  expect(manifest.layers).toHaveLength(2);
  const config = JSON.parse(Buffer.from(await store.read(result.config)).toString("utf8"));
  expect(config.config.Labels["org.bunko.base.digest"]).toBe(base("n").descriptor.digest);
  expect(config.config.Labels["org.opencontainers.image.created"]).toBe("1970-01-01T00:00:10Z");
  expect(sha256(canonicalJSON(config))).toBe(result.config.digest);
});

test("supports two successive rebases using the resolved first result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bunko-rebase-twice-")); dirs.push(dir); const store = new BlobStore(dir);
  const first = await rebaseImage(store, built(), base("a"), base("b"));
  const firstImage = await resolved(store, first);
  const second = await rebaseImage(store, firstImage, base("b"), base("c"));
  const secondImage = await resolved(store, second);
  expect(inspectRebase(secondImage, base("c")).layers.map((item) => item.kind)).toEqual(["runtime"]);
  expect(secondImage.config.config!.Labels!["org.bunko.base.digest"]).toBe(base("c").descriptor.digest);
  const secondConfig = JSON.parse(Buffer.from(await store.read(second.config)).toString("utf8"));
  expect(secondConfig.config.Labels["org.bunko.base.digest"]).toBe(base("c").descriptor.digest);
});

test("inherits replacement ports and base environment when ownership is inherited", async () => {
  const old = base("a"); old.config.config!.ExposedPorts = { "80/tcp": {} }; old.config.config!.Env = ["FLAG=old"];
  const replacement = base("b"); replacement.config.config!.ExposedPorts = { "443/tcp": {} }; replacement.config.config!.Env = ["FLAG=new"];
  const inheritedOptions = { ...options, env: {}, ports: undefined };
  const config = imageConfig(old.config, [layer], inheritedOptions); config.config!.Labels!["org.bunko.rebase.metadata"] = rebaseMetadata(old, [layer], inheritedOptions, context);
  const image = { descriptor: { mediaType: media.manifest, digest: d("i"), size: 1 }, manifest: { schemaVersion: 2 as const, mediaType: media.manifest, config: { mediaType: media.config, digest: d("ic"), size: 1 }, layers: [...old.manifest.layers, layer.descriptor] }, config } as BaseImage;
  const dir = await mkdtemp(join(tmpdir(), "bunko-rebase-inherit-")); dirs.push(dir); const store = new BlobStore(dir); const result = await rebaseImage(store, image, old, replacement);
  const output = JSON.parse(Buffer.from(await store.read(result.config)).toString("utf8"));
  expect(output.config.ExposedPorts).toEqual({ "443/tcp": {} }); expect(output.config.Env).toContain("FLAG=new");
});

test("preserves absent and empty history semantics across a changed base layer count", async () => {
  const old = base("a"); old.manifest.layers = []; old.config.rootfs.diff_ids = []; old.config.history = [];
  const replacement = base("b"); replacement.manifest.layers.push({ mediaType: media.tar, digest: d("g"), size: 1 }); replacement.config.rootfs.diff_ids.push(d("h")); replacement.config.history = [{ created: "1970-01-01T00:00:00Z", empty_layer: true }, { created_by: "base one", author: "fixture author" }, { created_by: "base two" }];
  const config = imageConfig(old.config, [layer], options); config.config!.Labels!["org.bunko.rebase.metadata"] = rebaseMetadata(old, [layer], options, context);
  const image = { descriptor: { mediaType: media.manifest, digest: d("i"), size: 1 }, manifest: { schemaVersion: 2 as const, mediaType: media.manifest, config: { mediaType: media.config, digest: d("ic"), size: 1 }, layers: [...old.manifest.layers, layer.descriptor] }, config } as BaseImage;
  const dir = await mkdtemp(join(tmpdir(), "bunko-rebase-history-")); dirs.push(dir); const store = new BlobStore(dir); const result = await rebaseImage(store, image, old, replacement);
  const output = JSON.parse(Buffer.from(await store.read(result.config)).toString("utf8"));
  expect(output.history[1].author).toBe("fixture author"); expect(output.history).toHaveLength(4); expect(output.history[0].empty_layer).toBe(true);
});

test("accepts arm64 replacement with omitted variant and explicit v8", async () => {
  const old = base("a"); old.config.architecture = "arm64"; const replacement = base("b"); replacement.config.architecture = "arm64"; replacement.config.variant = "v8";
  const armOptions = { ...options, platform: { os: "linux" as const, architecture: "arm64" as const } }; const config = imageConfig(old.config, [layer], armOptions); config.config!.Labels!["org.bunko.rebase.metadata"] = rebaseMetadata(old, [layer], armOptions, context);
  const image = { descriptor: { mediaType: media.manifest, digest: d("i"), size: 1 }, manifest: { schemaVersion: 2 as const, mediaType: media.manifest, config: { mediaType: media.config, digest: d("ic"), size: 1 }, layers: [...old.manifest.layers, layer.descriptor] }, config } as BaseImage;
  const dir = await mkdtemp(join(tmpdir(), "bunko-rebase-arm-")); dirs.push(dir); const store = new BlobStore(dir); await expect(rebaseImage(store, image, old, replacement)).resolves.toBeTruthy();
});

test("rejects unknown policies, invalid role order, and extra DiffIDs", () => {
  const image = built(); const capsule = JSON.parse(image.config.config!.Labels!["org.bunko.rebase.metadata"]!);
  capsule.ownership.env.unknown = true;
  const unknown = { ...image, config: { ...image.config, config: { ...image.config.config, Labels: { ...image.config.config!.Labels, "org.bunko.rebase.metadata": JSON.stringify(capsule) } } } } as BaseImage;
  expect(() => inspectRebase(unknown, base("a"))).toThrow();
  const roleCapsule = JSON.parse(image.config.config!.Labels!["org.bunko.rebase.metadata"]!); roleCapsule.generatedLayers[0].role = "app";
  const badRole = { ...image, config: { ...image.config, config: { ...image.config.config, Labels: { ...image.config.config!.Labels, "org.bunko.rebase.metadata": JSON.stringify(roleCapsule) } } } } as BaseImage;
  expect(() => inspectRebase(badRole, base("a"))).toThrow();
  const badRoles = { ...image, config: { ...image.config, rootfs: { ...image.config.rootfs, diff_ids: [...image.config.rootfs.diff_ids, d("1")] } } } as BaseImage;
  expect(() => inspectRebase(badRoles, base("a"))).toThrow();
  const extra = { ...image, config: { ...image.config, rootfs: { ...image.config.rootfs, diff_ids: [...image.config.rootfs.diff_ids, d("2")] } } } as BaseImage;
  expect(() => inspectRebase(extra, base("a"))).toThrow();
});

test("distinguishes explicit equal environment from inherited replacement value", async () => {
  const old = base("a"); old.config.config!.Env = ["FLAG=old"]; const replacement = base("b"); replacement.config.config!.Env = ["FLAG=new"];
  const inherited = { ...options, env: {} }; const config = imageConfig(old.config, [layer], inherited); config.config!.Labels!["org.bunko.rebase.metadata"] = rebaseMetadata(old, [layer], inherited, context);
  const image = { descriptor: { mediaType: media.manifest, digest: d("i"), size: 1 }, manifest: { schemaVersion: 2 as const, mediaType: media.manifest, config: { mediaType: media.config, digest: d("ic"), size: 1 }, layers: [...old.manifest.layers, layer.descriptor] }, config } as BaseImage;
  const explicit = built(); const dir = await mkdtemp(join(tmpdir(), "bunko-rebase-env-")); dirs.push(dir); const store = new BlobStore(dir);
  const inheritedResult = await rebaseImage(store, image, old, replacement); const inheritedConfig = JSON.parse(Buffer.from(await store.read(inheritedResult.config)).toString("utf8"));
  expect(inheritedConfig.config.Env).toContain("FLAG=new"); expect(inspectRebase(explicit, base("a")).options.env.FLAG).toBe("on");
});
