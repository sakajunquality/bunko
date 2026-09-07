import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { dockerCredentials } from "../packages/oci/credentials.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { Publisher, PublicationError } from "../packages/oci/publish.ts";
import { RegistryClient, webStream } from "../packages/oci/registry.ts";
import { media } from "../packages/oci/types.ts";
import { temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function dir() { const root = await temporary(); directories.push(root); return root; }
const anonymous = async () => undefined;

describe("Docker-compatible authentication", () => {
  test.each([
    ["ghcr.io", "ghcr.io", "github-token"],
    ["asia-northeast1-docker.pkg.dev", "asia-northeast1-docker.pkg.dev", "gcloud"],
    ["123456789012.dkr.ecr.ap-northeast-1.amazonaws.com", "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com", "ecr-login"],
    ["registry-1.docker.io", "https://index.docker.io/v1/", "desktop"],
  ])("resolves configured helpers for %s", async (registry, server, helper) => {
    const root = await dir(), file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ credHelpers: { [server!]: helper }, credsStore: "ignored", auths: { [registry!]: { auth: Buffer.from("stale:secret").toString("base64") } } }));
    const calls: string[] = [];
    const credentials = dockerCredentials(file, async (name, host) => { calls.push(`${name}:${host}`); return { username: "user", password: "secret" }; });
    expect(await credentials(registry!)).toEqual({ username: "user", password: "secret" });
    await credentials(registry!);
    expect(calls).toEqual([`${helper}:${server}`]);
    await credentials(registry!, true);
    expect(calls).toHaveLength(2);
  });

  test("does not fall back to stale auths after a selected helper fails", async () => {
    const root = await dir(), file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ credsStore: "broken", auths: { "ghcr.io": { auth: "dTpw" } } }));
    await expect(dockerCredentials(file, async () => { throw new Error("helper failed"); })("ghcr.io")).rejects.toThrow("helper failed");
  });

  test("Docker Hub aliases, colon passwords, identity tokens, and empty credentials", async () => {
    const root = await dir(), file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ auths: { "https://index.docker.io/v1/": { auth: Buffer.from("name:p:a:ss").toString("base64") }, "ghcr.io": { identitytoken: "refresh-token" } } }));
    const credentials = dockerCredentials(file);
    expect(await credentials("registry-1.docker.io")).toEqual({ username: "name", password: "p:a:ss" });
    expect(await credentials("ghcr.io")).toEqual({ identityToken: "refresh-token" });
    expect(await credentials("missing.example")).toBeUndefined();
  });

  test.each(["ghcr.io", "registry-1.docker.io", "us-docker.pkg.dev"])("exchanges Basic credentials for scoped Bearer tokens at %s", async (host) => {
    let tokens = 0;
    const client = new RegistryClient(host, { credentials: async () => ({ username: "user", password: "secret" }), fetcher: async (input, init) => {
      const url = new URL(input), auth = new Headers(init?.headers).get("Authorization");
      if (url.host === "auth.example") {
        expect(auth).toBe(`Basic ${Buffer.from("user:secret").toString("base64")}`);
        expect(url.searchParams.getAll("scope")).toEqual(["repository:team/app:pull,push", "repository:team/base:pull"]);
        tokens++;
        return Response.json({ access_token: "scoped", expires_in: 3600 });
      }
      return auth === "Bearer scoped" ? new Response(null, { status: 202 }) : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token",service="service"' } });
    } });
    await client.request("/v2/team/app/blobs/uploads/", { method: "POST" }, ["repository:team/app:pull,push", "repository:team/base:pull"]);
    await client.request("/v2/team/app/blobs/uploads/", { method: "POST" }, ["repository:team/app:pull,push", "repository:team/base:pull"]);
    expect(tokens).toBe(1);
  });

  test("ECR Basic challenge refreshes expired helper credentials", async () => {
    let calls = 0, rejectOnce = false;
    const client = new RegistryClient("123456789012.dkr.ecr.us-east-1.amazonaws.com", {
      credentials: async (_host, refresh) => { calls++; expect(Boolean(refresh)).toBe(calls > 1); return { username: "AWS", password: calls === 1 ? "old" : "new" }; },
      fetcher: async (_url, init) => {
        const auth = new Headers(init?.headers).get("Authorization");
        const accepted = auth === `Basic ${Buffer.from(`AWS:${rejectOnce ? "new" : "old"}`).toString("base64")}`;
        return accepted ? new Response(null, { status: 200 }) : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Amazon ECR"' } });
      },
    });
    await client.request("/v2/"); rejectOnce = true; await client.request("/v2/");
    expect(calls).toBe(2);
  });

  test("identity tokens use the OAuth refresh grant and never appear in URLs", async () => {
    const client = new RegistryClient("registry.example", { credentials: async () => ({ identityToken: "private-refresh" }), fetcher: async (input, init) => {
      const url = new URL(input);
      expect(url.toString()).not.toContain("private-refresh");
      if (url.host === "auth.example") {
        expect(init?.method).toBe("POST");
        const body = new URLSearchParams(await new Response(init?.body as BodyInit).text());
        expect(body.get("grant_type")).toBe("refresh_token"); expect(body.get("refresh_token")).toBe("private-refresh");
        return Response.json({ token: "access" });
      }
      return new Headers(init?.headers).has("Authorization") ? new Response("ok") : new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } });
    } });
    await client.request("/v2/");
  });

  test("bounded retries honor Retry-After and never send credentials to redirected storage", async () => {
    const delays: number[] = []; let requests = 0;
    const client = new RegistryClient("registry.example", { credentials: anonymous, sleep: async (ms) => { delays.push(ms); }, fetcher: async (input, init) => {
      const url = new URL(input);
      if (url.host === "storage.example") { expect(new Headers(init?.headers).has("Authorization")).toBe(false); return new Response("data"); }
      if (++requests < 3) return new Response(null, { status: 429, headers: { "Retry-After": "2" } });
      return new Response(null, { status: 307, headers: { Location: "https://storage.example/blob?signature=sensitive" } });
    } });
    expect(await (await client.request("/v2/app/blobs/digest")).text()).toBe("data");
    expect(delays).toEqual([2000, 2000]);
  });
});

describe("Distribution publication", () => {
  test.each(["asia-northeast1-docker.pkg.dev", "us-docker.pkg.dev:443"])("streams full blobs to Artifact Registry at %s", async (host) => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7), d = await store.put(bytes, media.gzip);
    const publisher = new Publisher(`${host}/project/repository/image`, { credentials: anonymous, fetcher: async (input, init) => {
      if (init?.method === "PATCH") throw new Error("Artifact Registry does not support chunked uploads");
      if (init?.method === "PUT") {
        expect(init.body).toBeInstanceOf(Blob);
        expect(new Headers(init.headers).get("Content-Length")).toBe(String(bytes.length));
        expect(new URL(input).searchParams.get("state")).toBe("opaque");
      }
      return registry.fetch(input, init);
    } });
    expect((await publisher.blob(store, d)).uploaded).toBe(bytes.length);
    const key = `${new URL(publisher.client.origin).host}/project/repository/image/${d.digest}`;
    expect(registry.blobs.get(key)).toEqual(bytes);
    expect(registry.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(registry.requests.some((r) => r.method === "GET" && r.url.pathname.includes("/uploads/"))).toBe(false);
  });

  test.each(["before", "after"])("reconciles a monolithic PUT disconnected %s commit", async (phase) => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const bytes = Buffer.from("complete file must be replayed"), d = await store.put(bytes, media.gzip);
    registry.disconnectFinish = phase === "after";
    let puts = 0;
    const publisher = new Publisher("us-docker.pkg.dev/project/repository/image", { credentials: anonymous, fetcher: async (input, init) => {
      if (init?.method === "PUT" && ++puts === 1 && phase === "before") {
        // Simulate a server that consumed the body and invalidated the session.
        await new Response(init.body as Blob).arrayBuffer();
        await registry.fetch(input, { method: "DELETE" });
        throw new Error("connection closed before commit");
      }
      return registry.fetch(input, init);
    } });
    await publisher.blob(store, d);
    expect(registry.blobs.get(`us-docker.pkg.dev/project/repository/image/${d.digest}`)).toEqual(bytes);
    expect(puts).toBe(phase === "before" ? 2 : 1);
    expect(registry.requests.filter((r) => r.method === "POST")).toHaveLength(phase === "before" ? 2 : 1);
  });

  test.each([403, 503])("bounds monolithic retries for HTTP %s", async (status) => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const d = await store.put(Buffer.from("rejected upload"), media.gzip);
    let puts = 0;
    const publisher = new Publisher("us-docker.pkg.dev/project/repository/image", { credentials: anonymous, fetcher: async (input, init) => {
      if (init?.method === "PUT") { puts++; return new Response(null, { status }); }
      return registry.fetch(input, init);
    } });
    await expect(publisher.blob(store, d)).rejects.toThrow(`Registry PUT failed (${status})`);
    expect(puts).toBe(status === 403 ? 1 : 3);
    expect(registry.requests.filter((r) => r.method === "DELETE")).toHaveLength(puts);
  });

  test("empty upload Range 0-0 is restarted without skipping the first byte", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    registry.disconnectBeforePatch = true;
    const d = await store.put(Buffer.from("first byte must survive"), media.gzip);
    await new Publisher("registry.example/app", { fetcher: registry.fetch, credentials: anonymous }).blob(store, d);
    expect(Buffer.from(registry.blobs.get(`registry.example/app/${d.digest}`)!).toString()).toBe("first byte must survive");
    expect(registry.requests.filter((r) => r.method === "POST")).toHaveLength(2);
  });

  test("a committed manifest PUT is reconciled after connection loss", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry(); registry.disconnectManifest = true;
    const config = await store.put(canonicalJSON({}), media.config);
    const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config, layers: [] }), media.manifest);
    const result = await new Publisher("registry.example/app", { fetcher: registry.fetch, credentials: anonymous }).publish(store, manifest, ["latest"]);
    expect(result.published).toBe(true);
    expect(registry.requests.filter((r) => r.method === "PUT" && r.url.pathname.endsWith(`/manifests/${manifest.digest}`))).toHaveLength(1);
  });

  test("HTTP reader cleanup cannot replace successfully read bytes", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("payload")); controller.close(); } });
    const reader = stream.getReader();
    reader.releaseLock = () => { throw new TypeError("simulated Bun release failure"); };
    stream.getReader = (() => reader) as typeof stream.getReader;
    expect(Buffer.concat(await Array.fromAsync(webStream(stream))).toString()).toBe("payload");
  });
  test.each(["success", "upload", "unsupported"] as const)("handles cross-repository mount %s without redundant upload sessions", async (mount) => {
    const root = await dir(), store = new BlobStore(root), registry = new MockRegistry(); registry.mount = mount;
    const bytes = Buffer.from("shared layer"), d = await store.put(bytes, media.gzip);
    store.origins.set(d.digest, { registry: "registry.example", repository: "source" });
    registry.blobs.set(`registry.example/source/${d.digest}`, bytes);
    const publisher = new Publisher("registry.example/destination", { fetcher: registry.fetch, credentials: anonymous });
    expect((await publisher.blob(store, d)).action).toBe(mount === "success" ? "mounted" : "uploaded");
    const posts = registry.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(mount === "unsupported" ? 2 : 1);
    expect((await publisher.blob(store, d)).action).toBe("reused");
  });

  test("resumes a committed PATCH and recognizes a completed PUT after connection loss", async () => {
    const root = await dir(), store = new BlobStore(root), registry = new MockRegistry();
    registry.disconnectPatch = true; registry.disconnectFinish = true;
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7), d = await store.put(bytes, media.gzip);
    const result = await new Publisher("registry.example/app", { fetcher: registry.fetch, credentials: anonymous }).blob(store, d);
    expect(result.uploaded).toBe(bytes.length);
    expect(registry.blobs.get(`registry.example/app/${d.digest}`)).toEqual(bytes);
    expect(registry.requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
    expect(registry.requests.some((r) => r.method === "GET" && r.url.pathname.includes("/uploads/"))).toBe(true);
  });

  test("dry-run only reads, and partial tag publication is reported without rollback", async () => {
    const root = await dir(), store = new BlobStore(root), registry = new MockRegistry();
    const config = await store.put(canonicalJSON({}), media.config);
    const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config, layers: [] }), media.manifest);
    const publisher = new Publisher("registry.example/app", { fetcher: registry.fetch, credentials: anonymous });
    const plan = await publisher.publish(store, manifest, ["first", "second"], undefined, true);
    expect(plan.published).toBe(false); expect(plan.transfers[0]!.action).toBe("would-upload");
    expect(registry.requests.every((r) => ["GET", "HEAD"].includes(r.method))).toBe(true);
    registry.failTag = "second";
    try { await publisher.publish(store, manifest, ["first", "second"]); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
      const result = (error as PublicationError).result;
      expect(result.published).toBe(true); expect(result.tags).toEqual(["first"]); expect(result.pendingTags).toEqual(["second"]);
      expect(registry.manifests.has(`registry.example/app/${manifest.digest}`)).toBe(true);
    }
  });
});
