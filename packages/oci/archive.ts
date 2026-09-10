import { spawn, mkdtemp } from "../runtime/invocation.ts";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BlobStore } from "./blob-store.ts";
import { decodeLayer } from "./decode.ts";
import { canonicalJSON } from "./digest.ts";
import { tar, type TarEntry } from "./tar.ts";
import type { Descriptor, ImageConfig, ImageManifest } from "./types.ts";

export async function assertFileAvailable(path: string, name = "Output"): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`${name} already exists: ${path}`);
}

/** Docker's archive format, with verified uncompressed layers (also works with the classic image store). */
export async function exportDockerArchive(store: BlobStore, manifest: Descriptor, output: string, tag: string, epoch: number): Promise<void> {
  await assertFileAvailable(output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".bunko-archive-"));
  try {
    const image: ImageManifest = JSON.parse(Buffer.from(await store.read(manifest)).toString());
    const config: ImageConfig = JSON.parse(Buffer.from(await store.read(image.config)).toString());
    if (image.layers.length !== config.rootfs.diff_ids.length) throw new Error("Archive layer/DiffID count mismatch");
    const configName = `${image.config.digest.slice(7)}.json`;
    const entries: TarEntry[] = [{ path: configName, type: "file", content: await store.read(image.config) }];
    const layers: string[] = [];
    for (const [i, layer] of image.layers.entries()) {
      const file = join(temporary, `layer-${i}.tar`);
      await decodeLayer(store, layer, config.rootfs.diff_ids[i]!, file, 2 * 1024 ** 3);
      const path = `${i}-${layer.digest.slice(7)}/layer.tar`;
      entries.push({ path, type: "file", source: file, size: (await stat(file)).size });
      layers.push(path);
    }
    entries.push({ path: "manifest.json", type: "file", content: canonicalJSON([{ Config: configName, RepoTags: [tag], Layers: layers }]) });
    const archive = join(temporary, "image.tar");
    await pipeline(Readable.from(tar(entries, epoch)), createWriteStream(archive, { flags: "wx" }));
    // Hard-link within the output filesystem provides an atomic no-overwrite commit.
    await link(archive, output);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function command(args: string[]): Promise<string> {
  const child = spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed (exit ${code}): ${stderr.trim()}`);
  return stdout.trim();
}

export async function loadArchive(archive: string, tag: string, kind?: string): Promise<void> {
  if (kind) {
    const nodes = (await command(["kind", "get", "nodes", "--name", kind])).split(/\r?\n/).filter(Boolean);
    if (!nodes.length) throw new Error(`No nodes in kind cluster: ${kind}`);
    await command(["kind", "load", "image-archive", archive, "--name", kind]);
    for (const node of nodes) {
      const info = JSON.parse(await command(["docker", "exec", node, "crictl", "inspecti", tag]));
      if (!info.status?.repoTags?.includes(tag)) throw new Error(`Loaded image tag was not found in kind node: ${node}`);
    }
  } else {
    await command(["docker", "image", "load", "--input", archive]);
    const info = JSON.parse(await command(["docker", "image", "inspect", tag]));
    if (!info[0]?.RepoTags?.includes(tag)) throw new Error("Loaded image tag was not found in Docker");
  }
}
