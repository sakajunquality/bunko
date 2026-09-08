import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { RegistrySource, resolveBase } from "../packages/oci/source.ts";
import { decodeLayer } from "../packages/oci/decode.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { media } from "../packages/oci/types.ts";
import { exportLayout } from "../packages/oci/layout.ts";
import { platform } from "../packages/bunko/config.ts";
import { build } from "../packages/bunko/build.ts";
import { project } from "./helpers.ts";
import { command } from "./command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-zstd-"));
try {
  const source = await project(join(root, "source"));
  for (const target of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) {
    const selected = platform(target), store = new BlobStore(join(root, `store-${selected.architecture}`));
    const base = await resolveBase(new RegistrySource("oven/bun:1.3.11-distroless"), selected, store);
    const layers = [];
    for (const [i, layer] of base.manifest.layers.entries()) {
      const tar = join(root, `${selected.architecture}-${i}.tar`);
      await decodeLayer(store, layer, base.config.rootfs.diff_ids[i]!, tar, 2 * 1024 ** 3);
      layers.push(await store.put(await Bun.zstdCompress(await readFile(tar)), media.zstd));
    }
    const manifest = await store.put(canonicalJSON({ ...base.manifest, layers }), media.manifest);
    const layout = join(root, `base-${selected.architecture}`);
    await exportLayout(store, layout, manifest, [base.manifest.config, ...layers], "zstd-base");
    const tarball = join(root, `${selected.architecture}.tar`);
    await build({ path: source, baseLayout: layout, platform: target, tarball, push: false, localCache: false });
    const loaded = await command(["docker", "load", "--input", tarball]), image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw Error("Zstd base image was not loaded");
    try {
      if (await command(["docker", "run", "--rm", "--platform", target, "--network=none", "--read-only", "--cap-drop=ALL", image]) !== "hello bunko") throw Error("Zstd runtime failed");
      console.log(JSON.stringify({ platform: target, layers: layers.length, result: "PASS" }));
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
