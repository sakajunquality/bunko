import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { canonicalJSON, descriptor, object, sha256 } from "../oci/digest.ts";
import { LayoutSource, RegistrySource, type ImageSource } from "../oci/source.ts";
import { assertOutputAvailable } from "../oci/layout.ts";
import { responseBytes, type RegistryOptions } from "../oci/registry.ts";
import { media, type Descriptor } from "../oci/types.ts";
import { sbomType, provenanceType } from "./attest.ts";

export interface MetadataRecord { subject: Descriptor; manifest: Descriptor; payload: Descriptor; document: Record<string, unknown>; bytes: Uint8Array; reference?: string }
class UnsupportedMetadataError extends Error {}
const maximum = 8 * 1024 ** 2;
function metadataBudget(source: ImageSource, limit: number, label: string) {
  let total = 0;
  const charged = new Set<string>();
  const charge = (d: Descriptor) => {
    if (d.size > maximum) throw new Error(`${label} metadata exceeds individual size limit`);
    if (charged.has(d.digest)) return;
    if (total + d.size > limit) throw new Error(`${label} graph exceeds cumulative metadata byte budget`);
    charged.add(d.digest); total += d.size;
  };
  const bounded: ImageSource = { root: () => source.root(), blob: async (d) => { charge(d); return source.blob(d); } };
  return { bounded, charge };
}

async function json(source: ImageSource, store: BlobStore, d: Descriptor, optional = false) {
  if (d.size > maximum) throw new (optional ? UnsupportedMetadataError : Error)("Metadata exceeds size limit");
  await store.putStream(await source.blob(d), d.mediaType, d);
  try { return object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Metadata JSON"); }
  catch { throw new (optional ? UnsupportedMetadataError : Error)("Unsupported metadata JSON"); }
}
async function attachment(source: ImageSource, store: BlobStore, d: Descriptor, subjects: Set<string>): Promise<MetadataRecord> {
  const manifest = await json(source, store, d, true), subject = descriptor(manifest.subject);
  if (!subjects.has(subject.digest)) throw new Error("Metadata artifact subject mismatch");
  if (d.mediaType !== media.manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length > 32) throw new UnsupportedMetadataError("Unsupported metadata artifact");
  const config = descriptor(manifest.config);
  if (!config.mediaType.endsWith("+json") && config.mediaType !== "application/json") throw new UnsupportedMetadataError("Unsupported metadata config");
  await json(source, store, config, true);
  const payloads = manifest.layers.map(descriptor).filter((layer) => [sbomType, provenanceType].includes(layer.mediaType));
  if (payloads.length !== 1) throw new UnsupportedMetadataError("Metadata requires exactly one supported payload");
  const payload = payloads[0]!;
  if ([sbomType, provenanceType].includes(String(manifest.artifactType)) && payload.mediaType !== manifest.artifactType) throw new UnsupportedMetadataError("Metadata payload type mismatch");
  const document = await json(source, store, payload, true);
  if (payload.mediaType === sbomType) {
    if (!["SPDX-2.2", "SPDX-2.3"].includes(String(document.spdxVersion)) || document.SPDXID !== "SPDXRef-DOCUMENT" || typeof document.documentNamespace !== "string" || !URL.canParse(document.documentNamespace) || !Array.isArray(document.packages)) throw new UnsupportedMetadataError("Unsupported SPDX document");
  } else if (document._type !== "https://in-toto.io/Statement/v1" || document.predicateType !== "https://slsa.dev/provenance/v1") throw new UnsupportedMetadataError("Unsupported provenance statement");
  if (payload.mediaType === provenanceType && (!Array.isArray(document.subject) || !document.subject.some((item) => object(object(item, "Statement subject").digest, "Statement digest").sha256 === subject.digest.slice(7)))) throw new Error("Provenance statement subject mismatch");
  return { subject, manifest: d, payload, document, bytes: await store.read(payload) };
}

export async function baseInventory(reference: string, subjects: string[], registry: RegistryOptions): Promise<MetadataRecord & { described: string[] }> {
  if (!(reference.startsWith("layout:") && reference.length > 7) && !/@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("Base SBOM requires a digest-pinned OCI artifact reference or layout:DIR");
  const temporary = await mkdtemp(join(tmpdir(), "bunko-base-inventory-"));
  try {
    const source = reference.startsWith("layout:") ? new LayoutSource(resolve(reference.slice(7))) : new RegistrySource(reference, registry);
    const store = new BlobStore(temporary), root = await source.root(), accepted = new Set(subjects), candidates: MetadataRecord[] = [], visited = new Set<string>();
    const { bounded, charge } = metadataBudget(source, 32 * 1024 ** 2, "Base SBOM");
    charge(root.descriptor);
    await store.put(root.bytes, root.descriptor.mediaType);
    const walk = async (d: Descriptor, depth = 0): Promise<void> => {
      if (visited.has(d.digest)) return;
      if (depth > 5 || visited.size >= 1000) throw new Error("Base SBOM graph exceeds limit");
      visited.add(d.digest);
      const value = d.digest === root.descriptor.digest ? object(JSON.parse(Buffer.from(root.bytes).toString()), "Base SBOM root") : await json(bounded, store, d);
      if ([media.index, media.dockerIndex].includes(d.mediaType as typeof media.index)) {
        if (value.schemaVersion !== 2 || !Array.isArray(value.manifests)) throw new Error("Invalid base SBOM index");
        for (const child of value.manifests) await walk(descriptor(child), depth + 1);
      } else if (value.subject && accepted.has(descriptor(value.subject).digest) && Array.isArray(value.layers) && value.layers.some((layer: any) => layer?.mediaType === sbomType)) {
        if (candidates.length) throw new Error("Base SBOM must contain exactly one SPDX artifact for the selected base subject");
        candidates.push(await attachment(bounded, store, d, accepted));
      }
    };
    await walk(root.descriptor);
    if (candidates.length !== 1) throw new Error("Base SBOM must contain exactly one SPDX artifact for the selected base subject");
    const result = candidates[0]!;
    if (result.payload.mediaType !== sbomType) throw new Error("Base inventory must be SPDX");
    const ids = new Set((result.document.packages as unknown[]).map((p) => object(p, "SPDX package").SPDXID));
    const described = new Set<string>();
    for (const id of result.document.documentDescribes as unknown[] ?? []) if (typeof id === "string" && ids.has(id)) described.add(id);
    for (const raw of result.document.relationships as unknown[] ?? []) {
      const rel = object(raw, "SPDX relationship");
      if (rel.spdxElementId === "SPDXRef-DOCUMENT" && rel.relationshipType === "DESCRIBES" && typeof rel.relatedSpdxElement === "string" && ids.has(rel.relatedSpdxElement)) described.add(rel.relatedSpdxElement);
    }
    if (!described.size) throw new Error("Base SPDX must describe at least one package");
    const identity = source instanceof RegistrySource ? `${source.ref.registry}/${source.ref.repository}@${result.manifest.digest}` : `urn:bunko:base-sbom:${result.manifest.digest}`;
    return { ...result, reference: identity, described: [...described].sort() };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function inspectMetadata(reference: string, registry: RegistryOptions = {}) {
  if (!reference.startsWith("layout:") && !/@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error("Metadata requires a digest-pinned image or layout:DIR");
  const temporary = await mkdtemp(join(tmpdir(), "bunko-metadata-"));
  try {
    const source = reference.startsWith("layout:") ? new LayoutSource(resolve(reference.slice(7))) : new RegistrySource(reference, registry);
    const expectedSubjects = new Map<string, string>();
    const store = new BlobStore(temporary), root = await source.root(), subjects = new Set<string>(), candidates = new Map<string, Descriptor>(), visited = new Set<string>();
    const { bounded, charge } = metadataBudget(source, 128 * 1024 ** 2, "Image metadata");
    charge(root.descriptor);
    await store.put(root.bytes, root.descriptor.mediaType);
    async function walk(d: Descriptor, depth: number, outer = false) {
      if (visited.has(d.digest)) return;
      if (depth > 5 || visited.size >= 1000) throw new Error("Image metadata graph exceeds limit");
      visited.add(d.digest);
      const value = d.digest === root.descriptor.digest ? object(JSON.parse(Buffer.from(root.bytes).toString()), "Image root") : await json(bounded, store, d);
      if (value.subject) { if ([sbomType, provenanceType].includes(String(value.artifactType))) candidates.set(d.digest, d); return; }
      if (!outer) subjects.add(d.digest);
      if ([media.index, media.dockerIndex].includes(d.mediaType as typeof media.index)) {
        if (!Array.isArray(value.manifests)) throw new Error("Invalid image metadata index");
        for (const child of value.manifests) await walk(descriptor(child), depth + 1);
      } else if (![media.manifest, media.dockerManifest].includes(d.mediaType as typeof media.manifest)) throw new Error("Unsupported image metadata root");
    }
    await walk(root.descriptor, 0, source instanceof LayoutSource);
    if (source instanceof RegistrySource) for (const subject of subjects) {
      const path = `/v2/${source.ref.repository}/referrers/${subject}`, scope = [`repository:${source.ref.repository}:pull`];
      let url = new URL(path, source.client.origin), response = await source.client.request(url, {}, scope, [404, 405]);
      let fallback = false;
      if (!response.ok) {
        await response.body?.cancel(); fallback = true;
        url = new URL(`/v2/${source.ref.repository}/manifests/${subject.replace(":", "-")}`, source.client.origin);
        response = await source.client.request(url, {}, scope, [404]);
        if (response.status === 404) { await response.body?.cancel(); continue; }
      }
      const pages = new Set<string>();
      while (true) {
        if (pages.has(url.href) || pages.size >= 100) throw new Error("Invalid metadata pagination");
        pages.add(url.href);
        const bytes = await responseBytes(response);
        charge({ mediaType: media.index, size: bytes.length, digest: sha256(bytes) });
        const index = object(JSON.parse(Buffer.from(bytes).toString()), "Metadata referrers");
        if (index.mediaType !== media.index || !Array.isArray(index.manifests)) throw new Error("Invalid metadata referrers index");
        for (const value of index.manifests) {
          const d = descriptor(value);
          if ([sbomType, provenanceType].includes(d.artifactType ?? "")) {
            if (expectedSubjects.has(d.digest) && expectedSubjects.get(d.digest) !== subject) throw new Error("Metadata listed under different subjects");
            candidates.set(d.digest, d); expectedSubjects.set(d.digest, subject);
          }
          if (candidates.size > 1000) throw new Error("Too many metadata artifacts");
        }
        const link = response.headers.get("Link");
        if (!link || fallback) break;
        const next = /<([^>]+)>;\s*rel="?next"?/.exec(link)?.[1];
        if (!next) throw new Error("Invalid metadata pagination Link");
        const destination = new URL(next, url);
        if (destination.origin !== url.origin || destination.pathname !== path) throw new Error("Metadata pagination escaped subject");
        url = destination; response = await source.client.request(url, {}, scope);
      }
    }
    const records = [];
    const skipped: { manifest: Descriptor; reason: string }[] = [];
    let totalBytes = 0;
    for (const d of [...candidates.values()].sort((a, b) => a.digest.localeCompare(b.digest))) {
      let record: MetadataRecord;
      try { record = await attachment(bounded, store, d, subjects); }
      catch (error) { if (error instanceof UnsupportedMetadataError) { skipped.push({ manifest: d, reason: error.message }); continue; } throw error; }
      if (expectedSubjects.has(d.digest) && record.subject.digest !== expectedSubjects.get(d.digest)) throw new Error("Metadata referrer subject mismatch");
      totalBytes += record.bytes.byteLength;
      if (totalBytes > 128 * 1024 ** 2) throw new Error("Metadata payloads exceed total size limit");
      records.push(record);
    }
    return { records, skipped };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function imageMetadata(reference: string, registry: RegistryOptions = {}): Promise<MetadataRecord[]> {
  return (await inspectMetadata(reference, registry)).records;
}

export async function exportMetadata(reference: string, output: string, registry: RegistryOptions = {}) {
  output = resolve(output); await assertOutputAvailable(output);
  const { records, skipped } = await inspectMetadata(reference, registry);
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".bunko-metadata-"));
  try {
    const index = [];
    for (const record of records) {
      const file = `${record.manifest.digest.slice(7)}.${record.payload.mediaType === sbomType ? "spdx" : "provenance"}.json`;
      await writeFile(join(temporary, file), record.bytes);
      index.push({ file, subject: record.subject, manifest: record.manifest, payload: record.payload });
    }
    await writeFile(join(temporary, "index.json"), canonicalJSON({ schemaVersion: 1, records: index, skipped }));
    await assertOutputAvailable(output); await rename(temporary, output);
    return { records: index, skipped, directory: output };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
