import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { LayoutSource, resolveBase } from "../packages/oci/source.ts";
import { media } from "../packages/oci/types.ts";
import { baseLayout } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "bunko-image-compatibility-")); roots.push(root); return root; }

const amd64 = { os: "linux", architecture: "amd64" } as const;

async function withIndexEntries(root: string, edit: (manifests: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const index = JSON.parse(Buffer.from(await readFile(join(root, "index.json"))).toString());
  index.manifests = edit(index.manifests);
  await writeFile(join(root, "index.json"), canonicalJSON(index));
}

describe("index entries with artifactType", () => {
  test.each([media.config, media.dockerConfig])("a platform image with config artifactType %s is selectable", async (artifactType) => {
    const root = await temporary();
    const layout = await baseLayout(join(root, "layout"));
    await withIndexEntries(layout, (entries) => entries.map((entry) => ({ ...entry, artifactType })));
    const base = await resolveBase(new LayoutSource(layout), amd64, new BlobStore(join(root, "store")), true);
    expect(base.manifest.config.mediaType).toBe(media.config);
  });

  test("attestation and other non-image artifacts in an index are still skipped", async () => {
    const root = await temporary();
    const layout = await baseLayout(join(root, "layout"));
    let image: Record<string, unknown> | undefined;
    await withIndexEntries(layout, (entries) => {
      image = { ...entries[0]!, artifactType: media.config };
      const attestation = { ...entries[0]!, artifactType: "application/vnd.in-toto+json", platform: amd64, annotations: { "vnd.docker.reference.type": "attestation-manifest" } };
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
import { applyLayers, baseNode, layerPath, type BaseFilesystem, type BaseNode } from "../packages/bunko/runtime-layer.ts";

test("an image artifactType does not bypass the selected config type validation", async () => {
  const root = await temporary(), layout = await baseLayout(join(root, "layout"));
  const store = new BlobStore(layout), index = await Bun.file(join(layout, "index.json")).json();
  const manifest = JSON.parse(Buffer.from(await store.read(index.manifests[0])).toString());
  manifest.config.mediaType = "application/vnd.in-toto+json";
  const descriptor = await store.put(canonicalJSON(manifest), media.manifest);
  await withIndexEntries(layout, () => [{ ...descriptor, platform: amd64, artifactType: media.config }]);
  await expect(resolveBase(new LayoutSource(layout), amd64, new BlobStore(join(root, "store")), true)).rejects.toThrow("Base is an artifact, not a runnable image");
});

describe("layer entry names", () => {
  test("leading slashes are normalized like container runtimes do, traversal is still rejected", () => {
    expect(layerPath("/ko-app/tool")).toBe("ko-app/tool");
    expect(layerPath("//var/run/ko/")).toBe("var/run/ko");
    expect(layerPath("./etc/passwd")).toBe("etc/passwd");
    expect(layerPath("/")).toBe("");
    expect(layerPath("/./ko-app/tool/")).toBe("ko-app/tool");
    for (const path of ["../escape", "/../escape", "/./../escape", "/a//b", "/a/./b", "/a\\b", "/a\u0000b", "/a\u001bb", "/a\u007fb"]) {
      expect(() => layerPath(path)).toThrow("Unsupported path in runtime base filesystem");
    }
    expect(() => layerPath("/" + "a".repeat(4097))).toThrow("inspection limits");
    expect(() => layerPath("/" + Array(129).fill("a").join("/"))).toThrow("inspection limits");
    expect(() => layerPath("/ko-app/../etc/passwd")).toThrow('Unsupported path in runtime base filesystem: "/ko-app/../etc/passwd"');
    expect(() => layerPath("a\\b")).toThrow("Unsupported path in runtime base filesystem");
  });

  test("absolute and relative image links retain their root-relative resolution", () => {
    const file: BaseNode = { type: "file", mode: 0o755, size: 6 };
    const tree: BaseFilesystem = new Map([
      ["ko-app/tool", file],
      ["bin/absolute", { type: "symlink", link: "/ko-app/tool", mode: 0o777, size: 0 }],
      ["bin/relative", { type: "symlink", link: "../ko-app/tool", mode: 0o777, size: 0 }],
      ["bin/hard", { type: "link", link: "ko-app/tool", mode: 0o755, size: 0 }],
    ]);
    for (const path of ["/bin/absolute", "/bin/relative", "/bin/hard"]) expect(baseNode(tree, path)).toBe(file);
    expect(tree.get("bin/absolute")?.link).toBe("/ko-app/tool");
    expect(() => layerPath("/a\x7fb")).toThrow('"/a\\u007fb"');
  });

  test("a ko-built layer with absolute entry names applies cleanly", async () => {
    const root = await temporary();
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
