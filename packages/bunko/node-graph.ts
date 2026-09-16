import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { mkdtemp } from "../runtime/invocation.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { BaseImage, Layer } from "../oci/types.ts";
import { applyLayers } from "./runtime-layer.ts";
import { rejectBunRuntime } from "./node-syntax.ts";
import { rejectMacroSyntax } from "./syntax.ts";

/** Inspect the reachable Node graph of the actual packaged layers, including cache hits.
 * No package code, install scripts, or macros execute; output is discarded. */
export async function checkNodeLayers(store: BlobStore, base: BaseImage, layers: Layer[], entries: string[], temporary: string): Promise<void> {
  const directory = await mkdtemp(join(temporary, "node-graph-")), root = join(directory, "image");
  const captures = new Map<string, string>();
  try {
    const input = { ...base, manifest: { ...base.manifest, layers: layers.map((layer) => layer.descriptor) }, config: { ...base.config, rootfs: { type: "layers" as const, diff_ids: layers.map((layer) => layer.diffId) } } };
    const tree = await applyLayers(store, input, directory, async (index, path, node, stream) => {
      if (!stream || node.type !== "file" || !/\.(?:[cm]?[jt]sx?|json)$/.test(path)) return;
      if (node.size > 64 * 1024 * 1024) throw new Error("Node graph source exceeds static validation limit");
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of stream) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 64 * 1024 * 1024) throw new Error("Node graph source exceeds static validation limit"); chunks.push(bytes); }
      const file = join(directory, `input-${captures.size}`);
      await writeFile(file, Buffer.concat(chunks)); captures.set(`${index}:${path}`, file);
    });
    await mkdir(root);
    // Write regular files before creating links, and never traverse image links on the host.
    for (const [path, node] of tree) {
      let parent = posix.dirname(path);
      while (parent !== ".") {
        if (tree.get(parent)?.type !== "directory") throw new Error("Node graph input has a non-directory ancestor");
        parent = posix.dirname(parent);
      }
      const target = join(root, path);
      if (node.type === "directory") await mkdir(target, { recursive: true });
      else if (node.type === "file") {
        await mkdir(dirname(target), { recursive: true });
        const captured = captures.get(`${node.layer}:${path}`);
        // Unknown data types need only exist for resolution; no executable loader is assigned.
        await writeFile(target, captured ? await readFile(captured) : "");
      }
    }
    for (const [path, node] of tree) if (node.type === "symlink" || node.type === "link") {
      if (!node.link || /[\\\x00-\x1f]/.test(node.link)) throw new Error("Invalid Node graph link");
      const target = posix.resolve("/", node.type === "link" ? "/" : posix.dirname(path), node.link);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await symlink(relative(dirname(join(root, path)), join(root, target)) || ".", join(root, path));
    }
    const canonical = await realpath(root);
    const result = await Bun.build({
      entrypoints: entries.map((path) => join(root, path)), target: "node", format: "esm", throw: false,
      packages: "bundle", env: "disable", plugins: [{ name: "node-runtime-graph", setup(builder) {
        builder.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
        builder.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
          const path = await realpath(args.path), local = relative(canonical, path);
          if (local === ".." || local.startsWith("../") || resolve(canonical, local) !== path) throw new Error("Node graph escaped packaged inputs");
          if (!/\.[cm]?[jt]sx?$/.test(path)) return { contents: await readFile(path), loader: args.loader };
          const code = await readFile(path, "utf8");
          if (!/\.[cm]?js$/.test(path)) throw new Error("Node source mode does not support TypeScript/JSX imports; prebuild to JavaScript");
          rejectMacroSyntax(code, local);
          rejectBunRuntime(code, local, undefined, true);
          return { contents: code, loader: "js" };
        });
      } }],
    });
    if (!result.success) throw new Error(`Node runtime graph validation failed: ${result.logs.map((log) => log.message).join("; ")}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
