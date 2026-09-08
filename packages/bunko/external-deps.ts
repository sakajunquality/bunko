import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { canonicalJSON, descriptor, object, sha256 } from "../oci/digest.ts";
import { decodeLayer } from "../oci/decode.ts";
import { extractDependencies } from "../oci/extract.ts";
import { exportLayout } from "../oci/layout.ts";
import { LayoutSource, RegistrySource } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { media, type Platform } from "../oci/types.ts";
import { packLayer } from "../oci/tar.ts";
import { absolutePath, relativePath } from "./config.ts";
import { runtimeEntries } from "./deps.ts";

const configType = "application/vnd.bunko.dependencies.config.v1+json";
const artifactType = "application/vnd.bunko.dependencies.v1";
const lockDigest = (value: unknown) => sha256(canonicalJSON(value));

export async function packDependencies(directory: string, lockfile: string, platform: Platform, output: string, workdir = "/app", targetPath = "") {
  if (targetPath) targetPath = relativePath(targetPath.replace(/\/+$/, ""), "artifact target");
  absolutePath(workdir, "dependency destination workdir");
  const temporary = await mkdtemp(join(tmpdir(), "bunko-pack-deps-"));
  try {
    const source = join(temporary, "source");
    await mkdir(source);
    await cp(join(resolve(directory), "node_modules"), join(source, "node_modules"), { recursive: true, verbatimSymlinks: true });
    const content = await runtimeEntries(source, workdir.slice(1), platform, true);
    const store = new BlobStore(join(temporary, "store"));
    const layer = await packLayer(store, content.entries, "deps", 0);
    if (!layer) throw new Error("Dependency artifact cannot be empty");
    const lock = Bun.JSONC.parse(await readFile(lockfile, "utf8"));
    const config = await store.put(canonicalJSON({ schemaVersion: targetPath ? 2 : 1, targetPath: targetPath || undefined, platform, workdir, lockDigest: lockDigest(lock), layer }), configType);
    const root = { ...await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType, config, layers: [layer.descriptor] }), media.manifest), artifactType };
    await exportLayout(store, output, root, [config, layer.descriptor], "bunko-dependencies");
    return { schemaVersion: 1, digest: root.digest, platform, workdir, inventory: content.inventory, native: content.native, layout: output };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function importDependencies(reference: string, platform: Platform, workdir: string, lock: unknown, directory: string, registry: RegistryOptions, targetPath = "") {
  if (!reference.startsWith("layout:") && !/@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("External dependency registry artifacts require a digest-pinned reference");
  const source = reference.startsWith("layout:") ? new LayoutSource(resolve(reference.slice(7))) : new RegistrySource(reference, registry);
  const store = new BlobStore(join(directory, "store"));
  let root = await source.root();
  if (source instanceof LayoutSource) {
    const index = object(JSON.parse(Buffer.from(root.bytes).toString()), "Dependency layout");
    if (!Array.isArray(index.manifests) || index.manifests.length !== 1) throw new Error("Dependency layout must select one platform artifact");
    const selected = descriptor(index.manifests[0]);
    await store.putStream(await source.blob(selected), selected.mediaType, selected);
    root = { descriptor: selected, bytes: await store.read(selected) };
  }
  const manifest = object(JSON.parse(Buffer.from(root.bytes).toString()), "Dependency artifact");
  if (root.descriptor.mediaType !== media.manifest || manifest.artifactType !== artifactType || manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new Error("Unsupported dependency artifact contract");
  const configDescriptor = descriptor(manifest.config), layerDescriptor = descriptor(manifest.layers[0]);
  if (configDescriptor.mediaType !== configType || configDescriptor.size > 8 * 1024 ** 2 || layerDescriptor.mediaType !== media.gzip || layerDescriptor.size > 2 * 1024 ** 3) throw new Error("Unsupported dependency artifact media type or size");
  await store.putStream(await source.blob(configDescriptor), configDescriptor.mediaType, configDescriptor);
  const config = object(JSON.parse(Buffer.from(await store.read(configDescriptor)).toString()), "Dependency config");
  if (targetPath ? config.schemaVersion !== 2 || config.targetPath !== targetPath : config.schemaVersion !== 1) throw new Error("Dependency artifact target mismatch");
  if (config.workdir !== workdir || Buffer.compare(Buffer.from(canonicalJSON(config.platform)), Buffer.from(canonicalJSON(platform))) !== 0 || config.lockDigest !== lockDigest(lock)) throw new Error("Dependency artifact platform, destination or lock mismatch");
  const layer = object(config.layer, "Dependency layer");
  if (layer.kind !== "deps" || Buffer.compare(Buffer.from(canonicalJSON(layer.descriptor)), Buffer.from(canonicalJSON(layerDescriptor)))) throw new Error("Dependency layer mismatch");
  const diffId = descriptor({ mediaType: media.tar, size: 0, digest: layer.diffId }).digest;
  await store.putStream(await source.blob(layerDescriptor), layerDescriptor.mediaType, layerDescriptor);
  const tarfile = join(directory, "dependencies.tar");
  await decodeLayer(store, layerDescriptor, diffId, tarfile, 2 * 1024 ** 3);
  const tree = join(directory, "tree");
  await extractDependencies(tarfile, tree, `${workdir.slice(1)}/node_modules`);
  const content = await runtimeEntries(join(tree, workdir.slice(1)), workdir.slice(1), platform, true);
  return { ...content, artifactDigest: root.descriptor.digest };
}
