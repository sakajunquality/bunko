import { posix } from "node:path";
import { createHash } from "node:crypto";
import { applyLayers, baseNode, type BaseFilesystem, type BaseNode } from "./runtime-layer.ts";
import { libcLoader } from "./libc.ts";
import { releaseRevision, runtimeELF } from "./runtime-download.ts";
import { canonicalJSON, object } from "../oci/digest.ts";
import type { ImageOptions } from "../oci/image.ts";
import type { RebaseBuildContext } from "../oci/rebase-metadata.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { BaseImage, Digest } from "../oci/types.ts";

export interface RebaseAbiPolicy {
  schemaVersion: 1;
  transitions: { platform: string; oldBase: Digest; newBase: Digest; libc: "glibc" | "musl" }[];
}
export interface RebaseSafetyResult {
  policy: "identical-files" | "explicit-abi-contract";
  nativeAddons: number;
  runtimeOrigin: string;
}
type Inspection = { tree: BaseFilesystem; fingerprints: WeakMap<BaseNode, string>; bodies: WeakMap<BaseNode, Buffer>; native: WeakSet<BaseNode> };

async function inspect(store: BlobStore, image: BaseImage, temporary: string, target: string, generated = false): Promise<Inspection> {
  const fingerprints = new WeakMap<BaseNode, string>(), bodies = new WeakMap<BaseNode, Buffer>(), native = new WeakSet<BaseNode>();
  const tree = await applyLayers(store, image, temporary, async (_index, path, node, stream, metadata) => {
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    const capture = path === target ? 256 * 1024 ** 2 : ["etc/os-release", "usr/lib/os-release"].includes(path) ? 4096 : 0;
    let size = 0, prefix = Buffer.alloc(0);
    if (node.type === "file" && stream) for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); hash.update(bytes); size += bytes.length;
      if (prefix.length < 4) prefix = Buffer.concat([prefix, bytes.subarray(0, 4 - prefix.length)]);
      if (capture) {
        if (size > capture) throw new Error("Rebase file exceeds inspection limits");
        chunks.push(bytes);
      }
    }
    if (node.type === "file" && size !== node.size) throw new Error("Rebase file size differs from its archive header");
    if (path.endsWith(".node") || prefix.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) native.add(node);
    if (capture && node.type === "file") bodies.set(node, Buffer.concat(chunks));
    // File ownership and extended attributes can change loader behavior even when payloads match.
    const pax = Object.fromEntries(Object.entries(object(metadata?.pax ?? {}, "Layer extended attributes")).filter(([key]) => !["mtime", "atime", "ctime"].includes(key)));
    fingerprints.set(node, Buffer.from(canonicalJSON({ type: node.type, mode: node.mode, size: node.size, link: node.link || undefined,
      uid: metadata?.uid ?? 0, gid: metadata?.gid ?? 0, pax, ...(node.type === "file" ? { digest: hash.digest("hex") } : {}) })).toString());
    if (!["file", "directory", "link", "symlink"].includes(node.type)) throw new Error("Unsupported entry type in rebase layers");
  }, 200_000, () => { if (generated) throw new Error("Generated rebase layers contain a whiteout"); });
  return { tree, fingerprints, bodies, native };
}
function same(a: BaseNode | undefined, b: BaseNode | undefined, first: Inspection, second: Inspection): boolean {
  return Boolean(a && b && first.fingerprints.get(a) !== undefined && first.fingerprints.get(a) === second.fingerprints.get(b));
}
function osId(inspection: Inspection): string | undefined {
  const node = baseNode(inspection.tree, "/etc/os-release") ?? baseNode(inspection.tree, "/usr/lib/os-release");
  const bytes = node && inspection.bodies.get(node);
  if (!bytes) return;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const matches = [...text.matchAll(/^ID=(?:"([a-z0-9._-]+)"|'([a-z0-9._-]+)'|([a-z0-9._-]+))\r?$/gm)];
  if (matches.length !== 1) throw new Error("Cannot identify the rebase distribution");
  return matches[0]![1] ?? matches[0]![2] ?? matches[0]![3];
}
function executable(inspection: Inspection, path: string): BaseNode {
  // Absolute, direct files keep executable provenance unambiguous; wrapper scripts require rebuilding.
  const direct = inspection.tree.get(path), resolved = baseNode(inspection.tree, `/${path}`);
  if (!direct || direct !== resolved || direct.type !== "file" || !direct.size || !(direct.mode & 0o111)) throw new Error("Rebase Bun executable must be a direct regular executable file");
  return direct;
}
function loader(tree: BaseFilesystem, context: RebaseBuildContext, options: ImageOptions): void {
  const path = libcLoader(context.libc, options.platform), node = baseNode(tree, path);
  if (!node || node.type !== "file" || !node.size || !(node.mode & 0o111)) throw new Error(`Rebase base is missing executable ${context.libc} loader ${path}`);
}

/** Inspect all effective files before trusting a base transition; never execute image contents. */
export async function checkRebaseSafety(store: BlobStore, image: BaseImage, oldBase: BaseImage, newBase: BaseImage, options: ImageOptions,
  context: RebaseBuildContext, temporary: string, policy?: RebaseAbiPolicy): Promise<RebaseSafetyResult> {
  const entrypoint = options.entrypoint[0];
  if (!entrypoint || !entrypoint.startsWith("/") || entrypoint.split("/").some((part) => part === "." || part === "..")) throw new Error("Rebase requires an absolute Bun entrypoint");
  const target = entrypoint.slice(1);
  const old = await inspect(store, oldBase, temporary, target), fresh = await inspect(store, newBase, temporary, target);
  loader(old.tree, context, options); loader(fresh.tree, context, options);
  let selected: RebaseSafetyResult["policy"] = "identical-files";
  if (policy) {
    if (policy.schemaVersion !== 1 || !policy.transitions.some((item) => item.platform === `${options.platform.os}/${options.platform.architecture}` && item.oldBase === oldBase.descriptor.digest && item.newBase === newBase.descriptor.digest && item.libc === context.libc)) throw new Error("Rebase ABI policy does not authorize this exact base transition");
    if (!osId(old) || osId(old) !== osId(fresh)) throw new Error("Explicit ABI rebase policy requires the same identifiable Linux distribution");
    selected = "explicit-abi-contract";
  } else {
    for (const path of new Set([...old.tree.keys(), ...fresh.tree.keys()])) if (!same(old.tree.get(path), fresh.tree.get(path), old, fresh)) throw new Error(`Rebase base filesystem entry changed at ${path}; an explicit ABI contract or rebuild is required`);
  }
  const count = oldBase.manifest.layers.length;
  const generated: BaseImage = { ...image, manifest: { ...image.manifest, layers: image.manifest.layers.slice(count) }, config: { ...image.config, rootfs: { type: "layers", diff_ids: image.config.rootfs.diff_ids.slice(count) } } };
  const combined: BaseImage = { ...newBase, manifest: { ...newBase.manifest, layers: [...newBase.manifest.layers, ...generated.manifest.layers] }, config: { ...newBase.config, rootfs: { type: "layers", diff_ids: [...newBase.config.rootfs.diff_ids, ...generated.config.rootfs.diff_ids] } } };
  const gen = await inspect(store, generated, temporary, target, true), final = await inspect(store, combined, temporary, target);
  loader(final.tree, context, options);
  const finalRuntime = executable(final, target);
  const runtime = context.runtimeOrigin === "base" ? executable(old, target) : executable(gen, target);
  const owner = context.runtimeOrigin === "base" ? old : gen;
  if (!same(runtime, finalRuntime, owner, final)) throw new Error("Bun executable changed during rebase");
  const bytes = owner.bodies.get(runtime);
  if (!bytes) throw new Error("Cannot inspect the rebase Bun runtime");
  const elf = runtimeELF(bytes, options.platform, context.libc);
  const files = new Set<string>();
  for (const path of final.tree.keys()) {
    const node = baseNode(final.tree, `/${path}`);
    if (node?.type === "file" && node.size) files.add(posix.basename(path));
  }
  for (const name of elf.needed) {
    const muslLibc = context.libc === "musl" && ["libc.so", `libc.musl-${options.platform.architecture === "amd64" ? "x86_64" : "aarch64"}.so.1`].includes(name);
    const absolute = name.startsWith("/") ? baseNode(final.tree, name) : undefined;
    if (!muslLibc && !(name.includes("/") ? absolute?.type === "file" && absolute.size : files.has(name))) throw new Error(`Rebase runtime requires missing shared library ${name}`);
  }
  releaseRevision(bytes, { path: "", version: context.bunVersion, revision: context.bunRevision });
  let nativeAddons = 0;
  for (const [path, node] of gen.tree) {
    if (gen.native.has(node) && node !== runtime) nativeAddons++;
    if ((node.type === "link" || node.type === "symlink") && !baseNode(gen.tree, `/${path}`)) throw new Error("Generated rebase links must resolve within preserved layers");
    if (!same(node, final.tree.get(path), gen, final)) throw new Error(`Generated entry is not preserved after rebasing at ${path}`);
    const newNode = fresh.tree.get(path);
    if (newNode && !same(old.tree.get(path), newNode, old, fresh)) throw new Error(`Generated entry collides with changed new base entry at ${path}`);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = fresh.tree.get(parts.slice(0, i).join("/"));
      if (parent && parent.type !== "directory") throw new Error(`Generated entry has a non-directory new base parent at ${path}`);
    }
  }
  if (selected === "explicit-abi-contract" && nativeAddons) throw new Error("Explicit ABI rebase policy does not support native addons or unknown ELF files; rebuild instead");
  return { policy: selected, nativeAddons, runtimeOrigin: context.runtimeOrigin };
}
