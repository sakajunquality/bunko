import { BlobStore } from "./blob-store.ts";
import { canonicalJSON, descriptor, object } from "./digest.ts";
import { Publisher, PublicationError, type Transfer } from "./publish.ts";
import { responseBytes } from "./registry.ts";
import { media, type Descriptor } from "./types.ts";

export interface Artifact { subject: Descriptor; manifest: Descriptor; blobs: Descriptor[] }

export async function artifact(store: BlobStore, subject: Descriptor, type: string, payload: unknown): Promise<Artifact> {
  const config = await store.put(Buffer.from("{}"), "application/vnd.oci.empty.v1+json");
  const data = await store.put(canonicalJSON(payload), type);
  const manifest = { ...await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest,
    artifactType: type, subject, config, layers: [data] }), media.manifest), artifactType: type };
  return { subject, manifest, blobs: [config, data] };
}

/** A batch serializes tag-fallback updates per subject. Cross-process tag writes
 * are not transactional; verify each update and fail rather than claim success. */
export async function publishArtifacts(publisher: Publisher, store: BlobStore, artifacts: Artifact[], record: (transfers: Transfer[]) => void = () => {}): Promise<void> {
  for (const item of artifacts) {
    try {
      const publication = await publisher.publish(store, item.manifest, [], new Map(item.blobs.map((d) => [d.digest, "attestation"])));
      record(publication.transfers);
    } catch (error) {
      if (error instanceof PublicationError) record(error.result.transfers);
      throw error;
    }
    const path = `/v2/${publisher.ref.repository}/referrers/${item.subject.digest}`;
    let url = new URL(path, publisher.client.origin);
    url.searchParams.set("artifactType", item.manifest.artifactType!);
    let response = await publisher.client.request(url, {}, [publisher.scope], [404, 405]);
    if (response.ok) {
      const pages = new Set<string>();
      let found = false;
      while (true) {
        if (pages.has(url.href) || pages.size >= 100) throw new Error("Invalid referrers pagination");
        pages.add(url.href);
        const index = object(JSON.parse(Buffer.from(await responseBytes(response)).toString()), "Referrers index");
        if (index.mediaType !== media.index || !Array.isArray(index.manifests)) throw new Error("Invalid referrers response");
        found ||= index.manifests.some((value) => descriptor(value).digest === item.manifest.digest);
        const link = response.headers.get("Link");
        if (!link) break;
        const next = /<([^>]+)>;\s*rel="?next"?/.exec(link)?.[1];
        if (!next) throw new Error("Invalid referrers pagination Link");
        const destination = new URL(next, url);
        if (destination.origin !== url.origin || destination.pathname !== path) throw new Error("Referrers pagination escaped its registry subject");
        url = destination;
        response = await publisher.client.request(url, {}, [publisher.scope]);
      }
      if (!found) throw new Error("Registry referrers API did not retain the published attachment");
      continue;
    }
    await response.body?.cancel();
    const tag = item.subject.digest.replace(":", "-");
    const endpoint = `/v2/${publisher.ref.repository}/manifests/${tag}`;
    const read = async (): Promise<Descriptor[]> => {
      const response = await publisher.client.request(endpoint, {}, [publisher.scope], [404]);
      if (response.status === 404) { await response.body?.cancel(); return []; }
      const index = object(JSON.parse(Buffer.from(await responseBytes(response)).toString()), "Referrers fallback");
      if (index.mediaType !== media.index || !Array.isArray(index.manifests)) throw new Error("Referrers fallback tag is occupied by a non-index");
      return index.manifests.map((value) => {
        const d = descriptor(value), raw = object(value, "Referrer");
        if (raw.artifactType !== undefined && typeof raw.artifactType !== "string") throw new Error("Invalid referrer artifactType");
        return d;
      });
    };
    let retained = await read();
    for (let attempt = 0; ; attempt++) {
      const merged = new Map([...retained, item.manifest].map((d) => [d.digest, d]));
      const manifests = [...merged.values()].sort((a, b) => a.digest.localeCompare(b.digest));
      const index = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests }), media.index);
      await publisher.manifest(store, index, tag);
      retained = await read();
      if (manifests.every((d) => retained.some((actual) => actual.digest === d.digest))) break;
      if (attempt === 2) throw new Error("Concurrent referrers update did not retain the attachment");
      retained.push(...manifests);
    }
  }
}
