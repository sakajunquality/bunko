import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { LayoutSource, RegistrySource, parseReference, resolveBase, type Fetcher } from "../packages/oci/source.ts";
import { media, type ImageIndex, type ImageManifest } from "../packages/oci/types.ts";
import { baseLayout, readJSON, temporary } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function dir() { const p = await temporary(); directories.push(p); return p; }

describe("base image resolution", () => {
  test("normalizes Docker Hub references and keeps registry ports", () => {
    expect(parseReference("oven/bun:1.3.11-distroless")).toEqual({ registry: "registry-1.docker.io", repository: "oven/bun", reference: "1.3.11-distroless" });
    expect(parseReference("docker.io/alpine").repository).toBe("library/alpine");
    expect(parseReference(`localhost:5000/team/app@${sha256("manifest")}`)).toEqual({ registry: "localhost:5000", repository: "team/app", reference: sha256("manifest") });
  });
  test.each(["https://example.com/app", "registry.example/../app", "oven/bun?tag=x", "oven/bun@sha256:bad", "oven/bun:tag@" + sha256("x")])("rejects malformed reference %s", (value) => {
    expect(() => parseReference(value)).toThrow();
  });
  test("anonymous token flow requests pull scope and does not forward the token to blob storage", async () => {
    const body = canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, layers: [] });
    const requests: { url: string; authorization: string | null }[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      requests.push({ url: url.toString(), authorization });
      if (url.hostname === "auth.example") {
        expect(url.searchParams.get("scope")).toBe("repository:team/app:pull");
        return Response.json({ token: "test-token" });
      }
      if (url.hostname === "storage.example") {
        expect(authorization).toBeNull();
        return new Response("blob");
      }
      if (!authorization) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="registry.example"' } });
      if (url.pathname.includes("/blobs/")) return new Response(null, { status: 307, headers: { location: "https://storage.example/object?signature=xyz" } });
      return new Response(Buffer.from(body), { headers: { "Content-Type": media.manifest, "Docker-Content-Digest": sha256(body) } });
    };
    const source = new RegistrySource("registry.example/team/app:latest", fetcher);
    expect((await source.root()).descriptor.digest).toBe(sha256(body));
    let bytes = "";
    for await (const chunk of await source.blob({ mediaType: media.gzip, size: 4, digest: sha256("blob") })) bytes += Buffer.from(chunk).toString();
    expect(bytes).toBe("blob");
    expect(requests).toHaveLength(5);
  });
  test("verifies digest-pinned root metadata", async () => {
    const source = new RegistrySource(`registry.example/app@${sha256("expected")}`, async () => new Response("{}"));
    await expect(source.root()).rejects.toThrow("digest mismatch");
  });
  test("rejects token realms and redirects that downgrade TLS", async () => {
    const token = new RegistrySource("registry.example/app", async () => new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="http://auth.example/token"' } }));
    await expect(token.root()).rejects.toThrow("HTTPS");
    const redirect = new RegistrySource("registry.example/app", async () => new Response(null, { status: 307, headers: { location: "http://storage.example/data" } }));
    await expect(redirect.root()).rejects.toThrow("HTTPS");
  });
  test("resolves local platform metadata and verifies every layer", async () => {
    const root = await dir();
    const base = await baseLayout(join(root, "base"));
    const image = await resolveBase(new LayoutSource(base), { os: "linux", architecture: "amd64" }, new BlobStore(join(root, "store")));
    expect(image.config.config?.Env).toContain("BASE_FLAG=retained");
    expect(image.manifest.layers).toHaveLength(1);
    const corrupt = new BlobStore(base).path(image.manifest.layers[0]!.digest);
    await writeFile(corrupt, "corrupt");
    await expect(resolveBase(new LayoutSource(base), { os: "linux", architecture: "amd64" }, new BlobStore(join(root, "other-store")))).rejects.toThrow("mismatch");
  });
  test("rejects absent or ambiguous platforms before assembling an image", async () => {
    const root = await dir();
    const base = await baseLayout(join(root, "base"));
    await expect(resolveBase(new LayoutSource(base), { os: "linux", architecture: "arm64" }, new BlobStore(join(root, "store")))).rejects.toThrow("found 0");
    const index: ImageIndex = JSON.parse(await readFile(join(base, "index.json"), "utf8"));
    index.manifests.push(index.manifests[0]!);
    await writeFile(join(base, "index.json"), canonicalJSON(index));
    await expect(resolveBase(new LayoutSource(base), { os: "linux", architecture: "amd64" }, new BlobStore(join(root, "store")))).rejects.toThrow("found 2");
  });
  test("arm64 without a variant matches the baseline v8 platform", async () => {
    const root = await dir();
    const base = await baseLayout(join(root, "base"), { os: "linux", architecture: "arm64" });
    const image = await resolveBase(new LayoutSource(base), { os: "linux", architecture: "arm64", variant: "v8" }, new BlobStore(join(root, "store")));
    expect(image.config.architecture).toBe("arm64");
  });
});

test("base layer descriptor annotations survive resolution and layout descriptor annotations survive export", async () => {
  const root = await dir(), input = await baseLayout(join(root, "base"));
  const store = new BlobStore(input), index = await Bun.file(join(input, "index.json")).json();
  const original = index.manifests[0];
  const manifest = await readJSON<ImageManifest>(input, original);
  manifest.layers[0]!.annotations = { "org.example.layer": "retained" };
  const descriptor = await store.put(canonicalJSON(manifest), media.manifest);
  index.manifests[0] = { ...descriptor, annotations: { "org.example.descriptor": "retained" } };
  await writeFile(join(input, "index.json"), canonicalJSON(index));
  const base = await resolveBase(new LayoutSource(input), { os: "linux", architecture: "amd64" }, new BlobStore(join(root, "resolved")));
  expect(base.manifest.layers[0]!.annotations).toEqual({ "org.example.layer": "retained" });
  const { exportLayout } = await import("../packages/oci/layout.ts");
  await exportLayout(store, join(root, "exported"), index.manifests[0], [manifest.config, ...manifest.layers], "bunko.local/base:test");
  expect((await Bun.file(join(root, "exported/index.json")).json()).manifests[0].annotations).toEqual({ "org.example.descriptor": "retained", "org.opencontainers.image.ref.name": "bunko.local/base:test" });
});


test("malformed base layer annotations are rejected before image assembly", async () => {
  const root = await dir();
  const layout = await baseLayout(join(root, "base")), store = new BlobStore(layout);
  const index = await Bun.file(join(layout, "index.json")).json();
  const original = await readJSON<any>(layout, index.manifests[0]);
  for (const annotations of [[], "invalid", { "org.example.layer": 1 }, null]) {
    const manifest = structuredClone(original);
    manifest.layers[0].annotations = annotations;
    index.manifests[0] = await store.put(canonicalJSON(manifest), media.manifest);
    await writeFile(join(layout, "index.json"), canonicalJSON(index));
    await expect(resolveBase(new LayoutSource(layout), { os: "linux", architecture: "amd64" }, new BlobStore(join(root, "resolved")))).rejects.toThrow("annotation");
  }
});
