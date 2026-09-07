import { resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { descriptor, object } from "../oci/digest.ts";
import { Publisher } from "../oci/publish.ts";
import { LayoutSource } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { publishArtifacts } from "../oci/artifacts.ts";

export async function pushLayout(directory: string, repository: string, tags: string[] = [], registry: RegistryOptions = {}) {
  directory = resolve(directory);
  const source = new LayoutSource(directory), index = object(JSON.parse(Buffer.from((await source.root()).bytes).toString()), "Layout index");
  if (!Array.isArray(index.manifests)) throw new Error("Invalid layout index");
  const descriptors = index.manifests.map(descriptor);
  const images = descriptors.filter((d) => !d.artifactType);
  // A standalone dependency artifact is also a valid immutable publication root.
  const roots = images.length ? images : descriptors;
  if (roots.length !== 1) throw new Error("push-layout requires exactly one image root or standalone artifact");
  const store = new BlobStore(directory), publisher = new Publisher(repository, registry);
  const publication = await publisher.publish(store, roots[0]!, tags);
  const attachments = [];
  for (const d of descriptors.filter((d) => d !== roots[0] && d.artifactType)) {
    const manifest = object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Artifact manifest");
    if (!Array.isArray(manifest.layers)) throw new Error("Invalid artifact layers");
    attachments.push({ subject: descriptor(manifest.subject), manifest: d, blobs: [descriptor(manifest.config), ...manifest.layers.map(descriptor)] });
  }
  await publishArtifacts(publisher, store, attachments, (transfers) => publication.transfers.push(...transfers));
  return publication;
}
