import { BlobStore } from "./blob-store.ts";
import { descriptor, object, sha256 } from "./digest.ts";
import { RegistryClient, RegistryError, responseBytes, type RegistryOptions } from "./registry.ts";
import { parseReference, type RegistryReference } from "./source.ts";
import { media, type Descriptor, type Digest } from "./types.ts";

export function repository(value: string): RegistryReference {
  if (value.includes("@") || value.lastIndexOf(":") > value.lastIndexOf("/")) throw new Error("Repository must not include a tag or digest");
  return parseReference(value);
}

export function repositoryName(ref: RegistryReference): string {
  return `${ref.registry === "registry-1.docker.io" ? "docker.io" : ref.registry}/${ref.repository}`;
}

export interface Transfer { digest: Digest; kind: string; size: number; uploaded: number; action: "reused" | "mounted" | "uploaded" | "would-upload" }
export interface Publication { reference: string; published: boolean; tags: string[]; pendingTags: string[]; transfers: Transfer[] }
export class PublicationError extends Error {
  constructor(message: string, readonly result: Publication, cause?: unknown) { super(message, { cause }); }
}

export class Publisher {
  readonly ref: RegistryReference;
  readonly client: RegistryClient;
  readonly scope: string;
  constructor(value: string, options: RegistryOptions = {}) {
    this.ref = repository(value);
    this.client = new RegistryClient(this.ref.registry, options);
    this.scope = `repository:${this.ref.repository}:pull,push`;
  }

  async exists(d: Descriptor): Promise<boolean> {
    const response = await this.client.request(`/v2/${this.ref.repository}/blobs/${d.digest}`, { method: "HEAD" }, [this.scope], [404]);
    await response.body?.cancel();
    if (response.status === 404) return false;
    const digest = response.headers.get("Docker-Content-Digest");
    const size = response.headers.get("Content-Length");
    if ((digest && digest !== d.digest) || (size && Number(size) !== d.size)) throw new Error("Registry blob HEAD digest/size mismatch");
    return true;
  }

  async blob(store: BlobStore, d: Descriptor, kind = "base", dryRun = false): Promise<Transfer> {
    const result: Transfer = { digest: d.digest, kind, size: d.size, uploaded: 0, action: "reused" };
    if (await this.exists(d)) return result;
    if (dryRun) return { ...result, action: "would-upload", uploaded: d.size };
    const origin = store.origins.get(d.digest);
    let location: string | undefined;
    if (origin?.registry === this.ref.registry && origin.repository !== this.ref.repository) {
      const path = new URL(`/v2/${this.ref.repository}/blobs/uploads/`, this.client.origin);
      path.searchParams.set("mount", d.digest);
      path.searchParams.set("from", origin.repository);
      const response = await this.client.request(path, { method: "POST" }, [this.scope, `repository:${origin.repository}:pull`], [400, 403, 404, 405]);
      await response.body?.cancel();
      if (response.status === 201) {
        if (!(await this.exists(d))) throw new Error("Mounted registry blob is missing");
        return { ...result, action: "mounted" };
      }
      if (response.status === 202) location = this.location(response, path.toString());
    }
    if (!location) {
      const path = `/v2/${this.ref.repository}/blobs/uploads/`;
      const response = await this.client.request(path, { method: "POST" }, [this.scope]);
      await response.body?.cancel();
      if (response.status !== 202) throw new Error("Registry did not create an upload session");
      location = this.location(response, new URL(path, this.client.origin).toString());
    }
    let complete = false;
    try {
      await store.ensure(d);
      const file = Bun.file(store.path(d.digest));
      if (file.size !== d.size) throw new Error("Upload blob size mismatch");
      let offset = 0;
      let failures = 0;
      const chunkSize = 8 * 1024 * 1024;
      while (offset < d.size) {
        const end = Math.min(offset + chunkSize, d.size);
        try {
          // File-backed slice uploads are unreliable with Bun 1.3.11. Use a
          // bounded buffer so the transmitted payload has the verified size.
          const bytes = Buffer.from(await file.slice(offset, end).arrayBuffer());
          if (bytes.length !== end - offset) throw new Error("Upload source changed while reading chunk");
          const response = await this.client.request(location, {
            method: "PATCH", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(end - offset), "Content-Range": `${offset}-${end - 1}` },
            body: bytes,
          }, [this.scope]);
          await response.body?.cancel();
          if (response.status !== 202) throw new Error("Registry did not accept upload chunk");
          location = this.location(response, location);
          offset = end;
          failures = 0;
        } catch (error) {
          if (++failures > 3) throw new Error(`${error instanceof Error ? error.message : "Upload failed"}; blob ${d.digest}, offset ${offset}/${d.size}`);
          // A disconnected PATCH can already have committed bytes. Query its
          // offset before replaying; never append the same bytes blindly.
          const status = await this.client.request(location, {}, [this.scope]);
          await status.body?.cancel();
          const range = /^(?:bytes=)?0-(\d+)$/.exec(status.headers.get("Range") ?? "");
          if (!range) throw new Error("Registry upload status has no valid Range");
          if (offset === 0 && range[1] === "0") {
            // Distribution reports 0-0 for an empty session as well as a
            // one-byte session. Start afresh instead of guessing and skipping
            // the first byte. Only this invocation's session is deleted.
            const cancel = await this.client.request(location, { method: "DELETE" }, [this.scope], [404, 405]);
            await cancel.body?.cancel();
            const path = `/v2/${this.ref.repository}/blobs/uploads/`;
            const fresh = await this.client.request(path, { method: "POST" }, [this.scope]);
            await fresh.body?.cancel();
            if (fresh.status !== 202) throw new Error("Registry did not restart upload session");
            location = this.location(fresh, new URL(path, this.client.origin).toString());
            continue;
          }
          const confirmed = Number(range[1]) + 1;
          if (!Number.isSafeInteger(confirmed) || confirmed < offset || confirmed > end) throw new Error("Registry upload offset is inconsistent");
          offset = confirmed;
          location = this.location(status, location);
        }
      }
      for (let attempt = 0; ; attempt++) {
        const finish = new URL(location);
        finish.searchParams.set("digest", d.digest);
        try {
          const response = await this.client.request(finish, { method: "PUT", headers: { "Content-Length": "0" } }, [this.scope]);
          await response.body?.cancel();
          if (response.status !== 201) throw new Error("Registry did not finalize upload");
          const digest = response.headers.get("Docker-Content-Digest");
          if (digest && digest !== d.digest) throw new Error("Registry upload digest mismatch");
          break;
        } catch (error) {
          if (await this.exists(d)) break;
          if (attempt >= 2) throw error;
        }
      }
      if (!(await this.exists(d))) throw new Error("Uploaded registry blob is missing");
      complete = true;
      return { ...result, action: "uploaded", uploaded: d.size };
    } finally {
      if (!complete) {
        try { const response = await this.client.request(location, { method: "DELETE" }, [this.scope], [404, 405]); await response.body?.cancel(); } catch { /* best effort upload-session cleanup */ }
      }
    }
  }

  private location(response: Response, from: string): string {
    const value = response.headers.get("Location");
    if (!value) throw new Error("Registry upload response has no Location");
    // Preserve the complete signed query; RegistryClient validates each request.
    return new URL(value, from).toString();
  }

  async manifest(store: BlobStore, d: Descriptor, reference: string = d.digest): Promise<void> {
    const bytes = await store.read(d);
    const path = `/v2/${this.ref.repository}/manifests/${reference}`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.client.request(path, { method: "PUT", headers: { "Content-Type": d.mediaType }, body: Buffer.from(bytes) }, [this.scope]);
        break;
      } catch (error) {
        const retryable = error instanceof RegistryError ? error.status === 429 || error.status >= 500 : error instanceof Error && error.message.includes("connection failed");
        if (!retryable) throw error;
        // A disconnected PUT may have succeeded. Reconcile exact bytes before
        // retrying the idempotent write or reporting a partial publication.
        const check = await this.client.request(path, {}, [this.scope], [404]);
        if (check.ok) { if (sha256(await responseBytes(check)) === d.digest) return; }
        else await check.body?.cancel();
        if (attempt >= 2) throw error;
      }
    }
    await response.body?.cancel();
    if (response.status !== 201 && response.status !== 202) throw new Error("Registry did not accept manifest");
    const declared = response.headers.get("Docker-Content-Digest");
    if (declared && declared !== d.digest) throw new Error("Published manifest digest mismatch");
    const check = await this.client.request(`/v2/${this.ref.repository}/manifests/${reference}`, {}, [this.scope]);
    if (sha256(await responseBytes(check)) !== d.digest) throw new Error("Registry changed the published manifest bytes");
  }

  async publish(store: BlobStore, root: Descriptor, tags: string[], kinds = new Map<Digest, string>(), dryRun = false): Promise<Publication> {
    for (const tag of tags) if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`Invalid image tag: ${tag}`);
    const result: Publication = { reference: `${repositoryName(this.ref)}@${root.digest}`, published: false, tags: [], pendingTags: [...tags], transfers: [] };
    const visited = new Set<Digest>();
    const visit = async (d: Descriptor) => {
      if (visited.has(d.digest)) return;
      visited.add(d.digest);
      if (d.mediaType === media.index) {
        const index = object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Image index");
        if (!Array.isArray(index.manifests)) throw new Error("Invalid image index");
        for (const child of index.manifests) await visit(descriptor(child));
      } else if (d.mediaType === media.manifest) {
        const manifest = object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Image manifest");
        if (!Array.isArray(manifest.layers)) throw new Error("Invalid image layers");
        for (const value of [...manifest.layers, manifest.config]) {
          const child = descriptor(value);
          if (visited.has(child.digest)) continue;
          visited.add(child.digest);
          result.transfers.push(await this.blob(store, child, kinds.get(child.digest) ?? (child.mediaType === media.config ? "config" : "base"), dryRun));
        }
      } else throw new Error("Publication root must be an OCI manifest or index");
      if (!dryRun) await this.manifest(store, d);
    };
    try {
      await visit(root);
      if (dryRun) return result;
      result.published = true;
      for (const tag of tags) {
        await this.manifest(store, root, tag);
        result.tags.push(tag);
        result.pendingTags.shift();
      }
      return result;
    } catch (error) { throw new PublicationError(error instanceof Error ? error.message : "Image publication failed", result, error); }
  }
}
