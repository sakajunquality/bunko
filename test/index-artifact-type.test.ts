import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { LayoutSource, resolveBase } from "../packages/oci/source.ts";
import { media } from "../packages/oci/types.ts";
import { baseLayout } from "./helpers.ts";

const amd64 = { os: "linux", architecture: "amd64" } as const;

async function withIndexEntries(root: string, edit: (manifests: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const index = JSON.parse(Buffer.from(await readFile(join(root, "index.json"))).toString());
  index.manifests = edit(index.manifests);
  await writeFile(join(root, "index.json"), canonicalJSON(index));
}

describe("index entries with artifactType", () => {
  test("a platform image whose artifactType is the config media type is selectable, as ko and BuildKit publish it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunko-artifact-type-"));
    const layout = await baseLayout(join(root, "layout"));
    await withIndexEntries(layout, (entries) => entries.map((entry) => ({ ...entry, artifactType: media.config })));
    const base = await resolveBase(new LayoutSource(layout), amd64, new BlobStore(join(root, "store")), true);
    expect(base.manifest.config.mediaType).toBe(media.config);
  });

  test("attestation and other non-image artifacts in an index are still skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunko-artifact-type-"));
    const layout = await baseLayout(join(root, "layout"));
    let image: Record<string, unknown> | undefined;
    await withIndexEntries(layout, (entries) => {
      image = { ...entries[0]!, artifactType: media.config };
      const attestation = { ...entries[0]!, artifactType: "application/vnd.in-toto+json", platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } };
      return [attestation, image];
    });
    const base = await resolveBase(new LayoutSource(layout), amd64, new BlobStore(join(root, "store")), true);
    expect(base.descriptor.digest).toBe(image!.digest as `sha256:${string}`);

    await withIndexEntries(layout, (entries) => entries.map((entry) => ({ ...entry, artifactType: "application/vnd.in-toto+json" })));
    await expect(resolveBase(new LayoutSource(layout), amd64, new BlobStore(join(root, "store-2")), true)).rejects.toThrow("Expected exactly one base for linux/amd64, found 0");
  });
});

import { createHash } from "node:crypto";
import { pack } from "tar-stream";
import { applyLayers, layerPath } from "../packages/bunko/runtime-layer.ts";

describe("layer entry names", () => {
  test("leading slashes are normalized like container runtimes do, traversal is still rejected", () => {
    expect(layerPath("/ko-app/tool")).toBe("ko-app/tool");
    expect(layerPath("//var/run/ko/")).toBe("var/run/ko");
    expect(layerPath("./etc/passwd")).toBe("etc/passwd");
    expect(layerPath("/")).toBe("");
    expect(() => layerPath("/ko-app/../etc/passwd")).toThrow('Unsupported path in runtime base filesystem: "/ko-app/../etc/passwd"');
    expect(() => layerPath("a\\b")).toThrow("Unsupported path in runtime base filesystem");
  });

  test("a ko-built layer with absolute entry names applies cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunko-ko-layer-"));
    const layout = await baseLayout(join(root, "layout"));
    const store = new BlobStore(layout);
    // ko writes its application layer with absolute names; reproduce that exactly.
    const tar = pack();
    tar.entry({ name: "/ko-app", type: "directory", mode: 0o755 });
    tar.entry({ name: "/ko-app/tool", type: "file", mode: 0o755, size: 6 }, "hello\n");
    tar.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
    const raw = Buffer.concat(chunks), gz = Buffer.from(Bun.gzipSync(raw));
    const layer = await store.put(gz, media.gzip);
    const diffId = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const index = JSON.parse(Buffer.from(await readFile(join(layout, "index.json"))).toString());
    const previous = JSON.parse(Buffer.from(await store.read(index.manifests[0])).toString());
    const config = JSON.parse(Buffer.from(await store.read(previous.config)).toString());
    config.rootfs.diff_ids.push(diffId); config.history.push({ created_by: "ko layer" });
    const c = await store.put(canonicalJSON(config), media.config);
    const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config: c, layers: [...previous.layers, layer] }), media.manifest);
    await writeFile(join(layout, "index.json"), canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [{ ...manifest, platform: amd64 }] }));
    const base = await resolveBase(new LayoutSource(layout), amd64, new BlobStore(join(root, "store")));
    const seen: string[] = [];
    await mkdir(join(root, "tmp"));
    const tree = await applyLayers(new BlobStore(join(root, "store")), base, join(root, "tmp"), async (_index, path) => { seen.push(path); });
    expect(tree.get("ko-app/tool")?.type).toBe("file");
    expect(seen).toContain("ko-app/tool");
    expect([...tree.keys()].some((key) => key.startsWith("/"))).toBe(false);
  });
});
