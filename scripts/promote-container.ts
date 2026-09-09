import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { assertDigest, descriptor, object } from "../packages/oci/digest.ts";
import { Publisher, repositoryName } from "../packages/oci/publish.ts";
import { RegistrySource } from "../packages/oci/source.ts";
import type { RegistryOptions } from "../packages/oci/registry.ts";
import { media } from "../packages/oci/types.ts";
import { releaseTag } from "./distribution.ts";

/** Promote the exact tested index in the same repository, preserving attestations. */
export async function promoteContainer(repository: string, digest: string, version: string, options: RegistryOptions = {}): Promise<void> {
  const tag = releaseTag(version);
  if (tag.length > 128) throw new Error("Container release tag exceeds registry limit");
  assertDigest(digest);
  const publisher = new Publisher(repository, options);
  const source = new RegistrySource(`${repositoryName(publisher.ref)}@${digest}`, options);
  const root = await source.root();
  if (![media.index, media.dockerIndex].includes(root.descriptor.mediaType as typeof media.index)) throw new Error("Container candidate must be a multi-platform index");
  const index = object(JSON.parse(Buffer.from(root.bytes).toString()), "Container index");
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) throw new Error("Invalid container candidate index");
  const children = index.manifests.map(descriptor);
  for (const architecture of ["amd64", "arm64"]) {
    if (children.filter((child) => child.platform?.os === "linux" && child.platform.architecture === architecture && !child.artifactType).length !== 1) throw new Error("Container candidate must include exactly one image per supported platform");
  }
  const temporary = await mkdtemp(join(tmpdir(), "bunko-container-promotion-"));
  try {
    const store = new BlobStore(temporary);
    const candidate = await store.put(root.bytes, root.descriptor.mediaType);
    const response = await publisher.client.request(`/v2/${publisher.ref.repository}/manifests/${tag}`, { method: "HEAD" }, [publisher.scope], [404]);
    await response.body?.cancel();
    if (response.status !== 404) throw new Error("Container version tag already exists; refusing replacement");
    // Workflow concurrency serializes our publishers. This is not a registry CAS.
    await publisher.manifest(store, candidate, tag);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const [repository, digest, version, ...extra] = process.argv.slice(2);
  if (!repository || !digest || !version || extra.length) throw new Error("Usage: promote-container.ts <repository> <digest> <version>");
  await promoteContainer(repository, digest, version);
}
