import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { dockerCredentials } from "../packages/oci/credentials.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { boundedMap } from "../packages/oci/concurrency.ts";
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

  test("new requests join an active Retry-After pause", async () => {
    let release!: () => void, issued = 0;
    const client = new RegistryClient("registry.example", { credentials: anonymous,
      sleep: () => new Promise<void>((resolve) => { release = resolve; }),
      fetcher: async () => { issued++; return new Response("ok"); } });
    const pause = client.backoff(0, "1");
    const request = client.request("/v2/");
    await Bun.sleep(10);
    expect(issued).toBe(0);
    release();
    await Promise.all([pause, request]);
    expect(issued).toBe(1);
  });

  test("later Retry-After responses extend the deadline from their arrival", async () => {
    const client = new RegistryClient("registry.example", { credentials: anonymous });
    const first = client.backoff(0, "1");
    await Bun.sleep(700);
    const started = performance.now();
    await client.backoff(0, "1");
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    await first;
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
    expect(delays).toHaveLength(2);
    for (const delay of delays) expect(delay).toBeCloseTo(2000, 0);
  });
});

describe("Distribution publication", () => {
  test.each(["asia-northeast1-docker.pkg.dev", "us-docker.pkg.dev:443", "ghcr.io", "ghcr.io:443"])("streams full blobs to %s", async (host) => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7), d = await store.put(bytes, media.gzip);
    const publisher = new Publisher(`${host}/project/repository/image`, { credentials: anonymous, fetcher: async (input, init) => {
      if (init?.method === "PATCH") throw new Error("This provider requires monolithic uploads");
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

  const layered = async (store: BlobStore, count: number) => {
    const layers = [];
    for (let index = 0; index < count; index++) layers.push(await store.put(Buffer.from(`layer ${index}`), media.gzip));
    const config = await store.put(canonicalJSON({ architecture: "amd64", os: "linux" }), media.config);
    return { layers, config, manifest: await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config, layers }), media.manifest) };
  };

  test("places every blob before the manifest and the manifest before the tag", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    registry.latencyMs = 5;
    const { layers, config, manifest } = await layered(store, 8);
    const result = await new Publisher("registry.example/app", { fetcher: registry.fetch, credentials: anonymous }).publish(store, manifest, ["latest"]);
    // Transfers stay in manifest order (layers, then config) whatever order the registry answered in.
    expect(result.transfers.map((transfer) => transfer.digest)).toEqual([...layers, config].map((d) => d.digest));
    expect(result.blobs).toEqual({ reused: 0, mounted: 0, uploaded: 9, wouldUpload: 0 });
    expect(result.elapsedMs).toBeGreaterThan(0);
    const request = (method: string, suffix: string) => registry.requests.find((r) => r.method === method && r.url.pathname.endsWith(suffix))!;
    const manifestPut = request("PUT", `/manifests/${manifest.digest}`), tagPut = request("PUT", "/manifests/latest");
    expect(registry.requests.filter((r) => r.url.pathname.includes("/blobs/")).every((r) => r.finished! <= manifestPut.started)).toBe(true);
    expect(manifestPut.finished!).toBeLessThanOrEqual(tagPut.started);
  });

  test.each([1, 4])("bounds parallel blob work to %i in-flight requests", async (limit) => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    registry.latencyMs = 25;
    const { manifest } = await layered(store, 11);
    const publisher = new Publisher("registry.example/app", { fetcher: registry.fetch, credentials: anonymous, publishConcurrency: limit });
    expect(publisher.concurrency).toBe(limit);
    await publisher.publish(store, manifest, ["latest"]);
    expect(registry.maxInFlight).toBe(limit);
    expect(registry.inFlight).toBe(0);
  });

  test("defaults stay per registry and reject an out-of-range override", async () => {
    expect(new Publisher("registry.example/app").concurrency).toBe(6);
    expect(new Publisher("asia-northeast1-docker.pkg.dev/project/repository/image").concurrency).toBe(6);
    // Docker Hub meters requests per account, so its default stays lower.
    expect(new Publisher("docker.io/owner/app").concurrency).toBe(3);
    expect(() => new Publisher("registry.example/app", { publishConcurrency: 0 })).toThrow("Publication concurrency must be an integer from 1 to 32");
    expect(() => new Publisher("registry.example/app", { publishConcurrency: 33 })).toThrow("Publication concurrency must be an integer from 1 to 32");
  });

  test("one scoped token serves a parallel batch", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    registry.latencyMs = 5;
    let tokens = 0;
    const { manifest } = await layered(store, 8);
    const publisher = new Publisher("registry.example/app", { credentials: async () => ({ username: "user", password: "secret" }), fetcher: async (input, init) => {
      const url = new URL(input);
      if (url.host === "auth.example") { tokens++; return Response.json({ access_token: "scoped", expires_in: 3600 }); }
      if (new Headers(init?.headers).get("Authorization") !== "Bearer scoped") return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } });
      return registry.fetch(input, init);
    } });
    await publisher.publish(store, manifest, ["latest"]);
    expect(tokens).toBe(1);
  });

  test("a refused blob upload fails the publication and writes no manifest", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const { layers, config, manifest } = await layered(store, 5);
    const refused = layers[2]!;
    const publisher = new Publisher("registry.example/app", { credentials: anonymous, fetcher: async (input, init) => {
      if (init?.method === "PUT" && new URL(input).searchParams.get("digest") === refused.digest) return new Response(null, { status: 403 });
      return registry.fetch(input, init);
    } });
    try { await publisher.publish(store, manifest, ["latest"]); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
      expect((error as Error).message).toBe("Registry PUT failed (403): registry.example");
      const result = (error as PublicationError).result;
      expect(result.published).toBe(false);
      // The batch that started alongside the refusal is still reported, in manifest order.
      expect(result.transfers.map((transfer) => transfer.digest)).toEqual([...layers.filter((d) => d !== refused), config].map((d) => d.digest));
      expect(result.blobs.uploaded).toBe(5);
      expect(result.elapsedMs).toBeGreaterThan(0);
    }
    expect(registry.manifests.size).toBe(0);
    expect(registry.inFlight).toBe(0);
    expect(registry.blobs.has(`registry.example/app/${refused.digest}`)).toBe(false);
  });

  test("a falsy rejection fails the publication before any manifest is written", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const { manifest } = await layered(store, 4);
    let challenges = 0;
    // A credential provider that rejects with undefined: the batch must still stop.
    const publisher = new Publisher("registry.example/app", { credentials: async () => { throw undefined; }, fetcher: async (input, init) => {
      if (init?.method === "HEAD" && ++challenges === 1) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } });
      return registry.fetch(input, init);
    } });
    try { await publisher.publish(store, manifest, ["latest"]); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
      expect((error as Error).message).toBe("Image publication failed");
      expect((error as PublicationError).result.published).toBe(false);
    }
    expect(registry.manifests.size).toBe(0);
  });

  // Provider hosts stream a full-file PUT; other registries finalize a chunked session.
  test.each([["chunked", "registry.example/app"], ["monolithic", "us-docker.pkg.dev/project/repository/image"]])("a failure waits for the %s upload already in flight", async (mode, repo) => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const { layers, manifest } = await layered(store, 3);
    const held = layers[0]!, refused = layers[1]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holding = false, finished = false;
    const publisher = new Publisher(repo!, { credentials: anonymous, fetcher: async (input, init) => {
      const url = new URL(input);
      // The refusal is immediate; the upload it races only completes well after it.
      if (init?.method === "HEAD" && url.pathname.endsWith(refused.digest)) { setTimeout(release, 30); return new Response(null, { status: 403 }); }
      if (init?.method === "PUT" && url.searchParams.get("digest") === held.digest) {
        holding = true; await gate;
        const response = await registry.fetch(input, init); finished = true; return response;
      }
      return registry.fetch(input, init);
    } });
    await expect(publisher.publish(store, manifest, ["latest"])).rejects.toThrow("Registry HEAD failed (403)");
    expect(holding).toBe(true);
    expect(finished).toBe(true);
    expect(registry.requests.some((r) => r.method === "PATCH")).toBe(mode === "chunked");
    expect(registry.inFlight).toBe(0);
    expect(registry.manifests.size).toBe(0);
  });

  test("a rejected shared token exchange does not poison the next attempt", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const { manifest } = await layered(store, 5);
    let attempts = 0;
    const publisher = new Publisher("registry.example/app", {
      credentials: async () => { if (++attempts === 1) throw new Error("credential helper failed"); return { username: "user", password: "secret" }; },
      fetcher: async (input, init) => {
        if (new URL(input).host === "auth.example") return Response.json({ access_token: "scoped", expires_in: 3600 });
        if (new Headers(init?.headers).get("Authorization") !== "Bearer scoped") return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.example/token"' } });
        return registry.fetch(input, init);
      },
    });
    await expect(publisher.publish(store, manifest, ["latest"])).rejects.toThrow("credential helper failed");
    expect(attempts).toBe(1);
    expect(registry.manifests.size).toBe(0);
    expect((await publisher.publish(store, manifest, ["latest"])).published).toBe(true);
  });

  test("a throttled parallel upload waits for the registry's Retry-After", async () => {
    const store = new BlobStore(await dir()), registry = new MockRegistry();
    const { manifest } = await layered(store, 5);
    const delays: number[] = [];
    let limited = 0;
    const publisher = new Publisher("registry.example/app", { credentials: anonymous, sleep: async (ms) => { delays.push(ms); }, fetcher: async (input, init) => {
      // Rate-limit the first upload sessions; recovery must honour Retry-After, not guess.
      if (init?.method === "POST" && limited < 3) { limited++; return new Response(null, { status: 429, headers: { "Retry-After": "2" } }); }
      return registry.fetch(input, init);
    } });
    const result = await publisher.publish(store, manifest, ["latest"]);
    expect(result.blobs.uploaded).toBe(6);
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every((ms) => ms > 0 && ms <= 2001)).toBe(true);
    expect(Math.max(...delays)).toBeCloseTo(2000, 0);
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

describe("Bounded publication fan-out", () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
    return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
  };

  test("reports the lowest-index failure even when a later job rejects first", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const work = boundedMap([0, 1], 2, async (index) => gates[index]!.promise);
    gates[1]!.reject(new Error("second failed"));
    await Bun.sleep(1);
    gates[0]!.reject(new Error("first failed"));
    const { results, failure } = await work;
    expect(failure!.index).toBe(0);
    expect((failure!.reason as Error).message).toBe("first failed");
    expect(results).toEqual([undefined, undefined]);
  });

  test("starts no job after a failure", async () => {
    const started: number[] = [];
    const { results, failure } = await boundedMap([0, 1, 2, 3, 4, 5], 2, async (index) => {
      started.push(index);
      if (index === 0) throw new Error("stop");
      return index;
    });
    expect(started).toEqual([0, 1]);
    expect(failure!.index).toBe(0);
    expect(results.slice(2).every((value) => value === undefined)).toBe(true);
  });

  test("reports a falsy rejection as a failure", async () => {
    const { results, failure } = await boundedMap([0, 1], 2, async (index) => { if (index === 1) throw undefined; return index; });
    expect(failure).toBeDefined();
    expect(failure!.index).toBe(1);
    expect(failure!.reason).toBeUndefined();
    expect(results[0]).toBe(0);
  });

  test("rejects an out-of-range bound and accepts an empty batch", async () => {
    await expect(boundedMap([1], 0, async (value) => value)).rejects.toThrow("Concurrency must be an integer from 1 to 32");
    expect(await boundedMap([], 4, async (value) => value)).toEqual({ results: [] });
  });
});
