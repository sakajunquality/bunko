import { sha256 } from "../packages/oci/digest.ts";
import type { Fetcher } from "../packages/oci/registry.ts";

/** In-memory Distribution endpoint, including dependency ordering and upload offsets. */
export class MockRegistry {
  readonly blobs = new Map<string, Uint8Array>();
  readonly manifests = new Map<string, { bytes: Uint8Array; type: string }>();
  readonly requests: { method: string; url: URL; headers: Headers }[] = [];
  private readonly sessions = new Map<string, { key: string; bytes: Uint8Array }>();
  mount: "success" | "upload" | "unsupported" = "success";
  disconnectPatch = false;
  disconnectBeforePatch = false;
  disconnectFinish = false;
  disconnectManifest = false;
  failTag?: string;
  cacheWritable = true;
  private counter = 0;
  fetch: Fetcher = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? "GET", headers = new Headers(init.headers);
    this.requests.push({ method, url, headers });
    const match = /^\/v2\/(.+)\/(blobs|manifests)\/(.*)$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const repo = match[1]!, kind = match[2]!, ref = match[3]!;
    const key = `${url.host}/${repo}`;
    const body = async () => init.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : new Uint8Array();
    if (kind === "manifests") {
      if (method === "PUT") {
        if (ref === this.failTag || (!this.cacheWritable && ref.startsWith("bunko-cache-"))) return new Response(null, { status: 403 });
        const bytes = await body(), digest = sha256(bytes), value = JSON.parse(Buffer.from(bytes).toString());
        const children = value.manifests ?? [...value.layers, value.config];
        if (children.some((d: { digest: string }) => !(value.manifests ? this.manifests : this.blobs).has(`${key}/${d.digest}`))) return new Response(null, { status: 400 });
        const data = { bytes, type: headers.get("Content-Type")! };
        this.manifests.set(`${key}/${ref}`, data);
        this.manifests.set(`${key}/${digest}`, data);
        if (this.disconnectManifest) { this.disconnectManifest = false; throw new Error("connection closed after storing manifest"); }
        return new Response(null, { status: 201, headers: { "Docker-Content-Digest": digest } });
      }
      const data = this.manifests.get(`${key}/${ref}`);
      return data ? new Response(method === "HEAD" ? null : Buffer.from(data.bytes), { headers: { "Content-Type": data.type, "Docker-Content-Digest": sha256(data.bytes), "Content-Length": String(data.bytes.length) } }) : new Response(null, { status: 404 });
    }
    if (ref.startsWith("uploads/")) {
      if (method === "POST") {
        const mount = url.searchParams.get("mount"), from = url.searchParams.get("from");
        if (mount && this.mount === "unsupported") return new Response(null, { status: 405 });
        if (mount && from && this.mount === "success") {
          const source = this.blobs.get(`${url.host}/${from}/${mount}`);
          if (source) { this.blobs.set(`${key}/${mount}`, source); return new Response(null, { status: 201 }); }
        }
        const id = String(++this.counter);
        this.sessions.set(id, { key, bytes: new Uint8Array() });
        return new Response(null, { status: 202, headers: { Location: `/v2/${repo}/blobs/uploads/${id}?state=opaque` } });
      }
      const id = ref.slice("uploads/".length), session = this.sessions.get(id);
      if (!session) return new Response(null, { status: 404 });
      if (url.searchParams.get("state") !== "opaque") return new Response(null, { status: 400 });
      const location = `${url.origin}${url.pathname}?state=opaque`;
      if (method === "DELETE") { this.sessions.delete(id); return new Response(null, { status: 204 }); }
      if (method === "GET") return new Response(null, { status: 204, headers: { Location: location, Range: `0-${Math.max(0, session.bytes.length - 1)}` } });
      if (method === "PATCH") {
        if (this.disconnectBeforePatch) { this.disconnectBeforePatch = false; throw new Error("connection closed before accepting chunk"); }
        const bytes = await body();
        if (headers.get("Content-Range") !== `${session.bytes.length}-${session.bytes.length + bytes.length - 1}`) return new Response(null, { status: 416 });
        session.bytes = Buffer.concat([session.bytes, bytes]);
        if (this.disconnectPatch) { this.disconnectPatch = false; throw new Error("connection closed after accepting chunk"); }
        return new Response(null, { status: 202, headers: { Location: location, Range: `0-${session.bytes.length - 1}` } });
      }
      if (method === "PUT") {
        const digest = sha256(session.bytes);
        if (url.searchParams.get("digest") !== digest) return new Response(null, { status: 400 });
        this.blobs.set(`${session.key}/${digest}`, session.bytes);
        this.sessions.delete(id);
        if (this.disconnectFinish) { this.disconnectFinish = false; throw new Error("connection closed after finalizing"); }
        return new Response(null, { status: 201, headers: { "Docker-Content-Digest": digest } });
      }
    }
    const bytes = this.blobs.get(`${key}/${ref}`);
    return bytes ? new Response(method === "HEAD" ? null : Buffer.from(bytes), { headers: { "Content-Length": String(bytes.length), "Docker-Content-Digest": sha256(bytes) } }) : new Response(null, { status: 404 });
  };
}
