import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { descriptor, object } from "../oci/digest.ts";
import { PublicationError, Publisher, type Publication, type TagConflict } from "../oci/publish.ts";
import { LayoutSource } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { publishArtifacts } from "../oci/artifacts.ts";
import { canonicalOutput } from "../oci/layout.ts";
import { assertReportNotInput, assertReportWritable, writeFailureReport, writeReport } from "./build.ts";
import { media, type Descriptor } from "../oci/types.ts";

export async function pushLayout(directory: string, repository: string, tags: string[] = [], registry: RegistryOptions = {}, reportPath?: string, tagConflict: TagConflict = "fail") {
  if (!["fail", "skip"].includes(tagConflict)) throw new Error("Tag conflict policy must be fail or skip");
  const report = reportPath ? await canonicalOutput(reportPath) : undefined;
  if (report) await assertReportWritable(report);
  const written = new Set<string>();
  directory = await canonicalOutput(directory);
  await assertReportNotInput(report, [directory]);
  const source = new LayoutSource(directory), index = object(JSON.parse(Buffer.from((await source.root()).bytes).toString()), "Layout index");
  if (!Array.isArray(index.manifests) || index.manifests.length > 100_000) throw new Error("Invalid layout index");
  const descriptors = index.manifests.map(descriptor), images = descriptors.filter((d) => !d.artifactType);
  const roots = images.length ? images : descriptors;
  if (roots.length !== 1) throw new Error("push-layout requires exactly one image root or standalone artifact");
  const temporary = await mkdtemp(join(tmpdir(), "bunko-push-layout-"));
  let publication: Publication | undefined;
  try {
    const store = new BlobStore(temporary), input = new BlobStore(directory), publisher = new Publisher(repository, registry);
    const visited = new Map<string, Descriptor>(), subjects = new Set<string>();
    async function copy(d: Descriptor, depth = 0, image = false) {
      if (depth > 128 || visited.size > 100_000) throw new Error("Layout graph exceeds the supported bounds");
      const previous = visited.get(d.digest);
      if (previous) {
        if (previous.mediaType !== d.mediaType || previous.size !== d.size) throw new Error("Conflicting layout descriptors");
        return;
      }
      visited.set(d.digest, d);
      if (!(await lstat(input.path(d.digest))).isFile()) throw new Error("Layout blobs must be regular files");
      await store.copyFrom(input, d);
      if (d.mediaType === media.index || d.mediaType === media.manifest) {
        const value = object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Layout manifest");
        if (value.schemaVersion !== 2 || value.mediaType !== d.mediaType) throw new Error("Invalid layout manifest schema");
        if (image && !value.artifactType) subjects.add(d.digest);
        const children = d.mediaType === media.index ? value.manifests : [...(Array.isArray(value.layers) ? value.layers : []), value.config];
        if (!Array.isArray(children) || d.mediaType === media.manifest && !Array.isArray(value.layers)) throw new Error("Invalid layout children");
        for (const child of children) await copy(descriptor(child), depth + 1, image);
      }
    }
    // Verify and snapshot every reachable blob before the first registry write.
    await copy(roots[0]!, 0, true);
    const attachments = [];
    for (const d of descriptors.filter((d) => d !== roots[0] && d.artifactType)) {
      await copy(d);
      const manifest = object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Artifact manifest");
      const subject = descriptor(manifest.subject), known = visited.get(subject.digest);
      if (!subjects.has(subject.digest) || !known || known.size !== subject.size || known.mediaType !== subject.mediaType || manifest.artifactType !== d.artifactType || !Array.isArray(manifest.layers)) throw new Error("Artifact subject/type does not match the layout image");
      attachments.push({ subject, manifest: d, blobs: [descriptor(manifest.config), ...manifest.layers.map(descriptor)] });
    }
    const retention = !tags.length && Boolean(roots[0]!.artifactType);
    const publicationTags = retention ? [`bunko-artifact-sha256-${roots[0]!.digest.slice(7)}`] : tags;
    publication = await publisher.publish(store, roots[0]!, publicationTags, undefined, false, retention ? "skip" : tagConflict);
    if (retention && publication.skippedTags?.length) throw new PublicationError("Content-addressed artifact retention tag points at another digest", publication);
    await publishArtifacts(publisher, store, attachments, (transfers) => publication!.transfers.push(...transfers));
    if (report) await writeReport(report, { schemaVersion: 1, command: "push-layout", status: "success", publication }, written);
    return publication;
  } catch (error) {
    if (!publication && error instanceof PublicationError) publication = error.result;
    if (report && !written.has(report)) await writeFailureReport(report, { schemaVersion: 1, command: "push-layout", status: "failed", publication, error: error instanceof Error ? error.message : "Layout publication failed" }, error);
    if (publication?.published) throw new PublicationError(`Layout publication incomplete; image root was published at ${publication.reference}: ${error instanceof Error ? error.message : "attachment failure"}`, publication, error);
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
