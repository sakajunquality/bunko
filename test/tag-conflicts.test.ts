import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { Publisher, PublicationError } from "../packages/oci/publish.ts";
import { media } from "../packages/oci/types.ts";
import { MockRegistry } from "./mock-registry.ts";
import { pushLayout } from "../packages/bunko/push-layout.ts";
import { join } from "node:path";
import { temporary } from "./helpers.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(status = 400, message = "The tag cannot be overwritten because the repository is immutable", code = "TAG_INVALID") {
  const root = await temporary(); roots.push(root);
  const store = new BlobStore(root), registry = new MockRegistry();
  const first = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [], annotations: { fixture: "first" } }), media.index);
  const second = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [], annotations: { fixture: "second" } }), media.index);
  const publisher = new Publisher("registry.example/app", { credentials: async () => undefined, sleep: async () => {}, fetcher: async (url, init) => {
    if (init?.method === "PUT" && new URL(url).pathname.endsWith("/latest") && registry.manifests.has("registry.example/app/latest")) return Response.json({ errors: [{ code, message }] }, { status });
    return registry.fetch(url, init);
  } });
  await publisher.publish(store, first, ["latest"]);
  return { store, registry, publisher, first, second };
}

test("skip reports confirmed immutable tags with their existing digest while publishing other tags", async () => {
  const f = await fixture();
  const result = await f.publisher.publish(f.store, f.second, ["latest", "new-version"], undefined, false, "skip");
  expect(result.published).toBe(true); expect(result.tags).toEqual(["new-version"]); expect(result.pendingTags).toEqual([]);
  expect(result.skippedTags).toEqual([{ tag: "latest", digest: f.first.digest, status: 400 }]);
  expect(f.registry.manifests.get("registry.example/app/latest")?.bytes).toEqual(await f.store.read(f.first));
});

test("same-digest immutable tags are reported as existing without a write", async () => {
  const f = await fixture(), before = f.registry.requests.filter((r) => r.method === "PUT" && r.url.pathname.endsWith("/latest")).length;
  const result = await f.publisher.publish(f.store, f.first, ["latest"], undefined, false, "skip");
  expect(result.tags).toEqual(["latest"]); expect(result.existingTags).toEqual(["latest"]); expect(result.skippedTags).toBeUndefined();
  expect(f.registry.requests.filter((r) => r.method === "PUT" && r.url.pathname.endsWith("/latest"))).toHaveLength(before);
});

test.each([400, 403, 409, 412])("generic status %s is never mistaken for immutable policy", async (status) => {
  const f = await fixture(status, "Permission denied or invalid tag", "DENIED");
  await expect(f.publisher.publish(f.store, f.second, ["latest"], undefined, false, "skip")).rejects.toThrow(PublicationError);
});

test("default fail keeps immutable refusal fatal and redacts upstream message text", async () => {
  const f = await fixture(400, "immutable tag; credential=fixture-secret");
  try { await f.publisher.publish(f.store, f.second, ["latest"]); throw new Error("Expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as Error).message).not.toContain("fixture-secret");
    expect((error as PublicationError).result.pendingTags).toEqual(["latest"]);
  }
});

test("skip does not prevent normal mutable tag updates", async () => {
  const f = await fixture();
  const publisher = new Publisher("registry.example/app", { credentials: async () => undefined, fetcher: f.registry.fetch });
  const result = await publisher.publish(f.store, f.second, ["latest"], undefined, false, "skip");
  expect(result.tags).toEqual(["latest"]); expect(result.skippedTags).toBeUndefined();
});

test("manifest readback tolerates delayed visibility but never accepts permanent wrong bytes", async () => {
  for (const permanent of [false, true]) {
    const f = await fixture(); let written = false, reads = 0;
    const publisher = new Publisher("registry.example/app", { credentials: async () => undefined, sleep: async () => {}, fetcher: async (url, init) => {
      if (init?.method === "PUT") { written = true; return f.registry.fetch(url, init); }
      if (written && (init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith("/delayed")) {
        reads++; if (reads === 1) return new Response(null, { status: 404 });
        if (permanent || reads === 2) return new Response(Buffer.from(await f.store.read(f.first)));
      }
      return f.registry.fetch(url, init);
    } });
    if (permanent) await expect(publisher.manifest(f.store, f.second, "delayed")).rejects.toThrow("bounded verification");
    else await publisher.manifest(f.store, f.second, "delayed");
    expect(reads).toBe(permanent ? 4 : 3);
  }
});


test("standalone artifact layouts receive a stable retention tag unless explicitly tagged", async () => {
  const f = await fixture(), config = await f.store.put(Buffer.from("{}"), "application/vnd.oci.empty.v1+json");
  const payload = await f.store.put(Buffer.from("artifact fixture"), "application/octet-stream"), artifactType = "application/vnd.example.artifact";
  const root = { ...await f.store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType, config, layers: [payload] }), media.manifest), artifactType };
  await writeFile(join(f.store.root, "oci-layout"), canonicalJSON({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(f.store.root, "index.json"), canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [root] }));
  const options = { fetcher: f.registry.fetch, credentials: async () => undefined };
  expect((await pushLayout(f.store.root, "registry.example/artifact", [], options)).tags).toEqual([`bunko-artifact-sha256-${root.digest.slice(7)}`]);
  expect((await pushLayout(f.store.root, "registry.example/artifact", ["explicit"], options)).tags).toEqual(["explicit"]);
});
