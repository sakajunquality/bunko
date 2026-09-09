import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { artifact, publishArtifacts } from "../packages/oci/artifacts.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { media } from "../packages/oci/types.ts";
import { temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await temporary(); roots.push(root);
  const store = new BlobStore(root), mock = new MockRegistry();
  const subject = { mediaType: media.manifest, digest: `sha256:${"a".repeat(64)}` as const, size: 123 };
  return { store, mock, subject };
}

test("an empty successful referrers probe without OCI-Subject does not suppress fallback", async () => {
  const { store, mock, subject } = await fixture(); let probes = 0;
  const publisher = new Publisher("registry.test/demo", { credentials: async () => undefined, fetcher: async (url, init) => {
    if (new URL(url).pathname.includes("/referrers/")) { probes++; return Response.json({ mediaType: media.index, manifests: [] }); }
    return mock.fetch(url, init);
  } });
  const item = await artifact(store, subject, "application/spdx+json", {});
  await publishArtifacts(publisher, store, [item]);
  expect(probes).toBe(0);
  expect(mock.manifests.has(`registry.test/demo/${subject.digest.replace(":", "-")}`)).toBe(true);
});

test("parallel fallback updates from distinct publishers retain every attachment", async () => {
  const { store, mock, subject } = await fixture();
  const items = await Promise.all(Array.from({ length: 8 }, (_, i) => artifact(store, subject, "application/spdx+json", { sequence: i })));
  await Promise.all(items.map((item) => publishArtifacts(new Publisher("registry.test/demo", { credentials: async () => undefined, fetcher: mock.fetch }), store, [item])));
  const retained = JSON.parse(Buffer.from(mock.manifests.get(`registry.test/demo/${subject.digest.replace(":", "-")}`)!.bytes).toString()).manifests;
  expect(retained.map((d: { digest: string }) => d.digest).sort()).toEqual(items.map((item) => item.manifest.digest).sort());
});

test("a wrong OCI-Subject acknowledgement fails publication", async () => {
  const { store, mock, subject } = await fixture();
  const item = await artifact(store, subject, "application/spdx+json", {});
  const publisher = new Publisher("registry.test/demo", { credentials: async () => undefined, fetcher: async (url, init) => {
    const response = await mock.fetch(url, init);
    if (init?.method === "PUT" && new URL(url).pathname.includes("/manifests/")) response.headers.set("OCI-Subject", `sha256:${"b".repeat(64)}`);
    return response;
  } });
  await expect(publishArtifacts(publisher, store, [item])).rejects.toThrow("OCI-Subject acknowledgement mismatch");
});

test("a disconnected successful artifact PUT uses conservative fallback without an acknowledgement", async () => {
  const { store, mock, subject } = await fixture(); mock.disconnectManifest = true; mock.acknowledgeSubjects = true;
  const item = await artifact(store, subject, "application/spdx+json", {});
  await publishArtifacts(new Publisher("registry.test/demo", { credentials: async () => undefined, retries: 0, fetcher: mock.fetch }), store, [item]);
  expect(mock.manifests.has(`registry.test/demo/${subject.digest.replace(":", "-")}`)).toBe(true);
});

test("acknowledged referrers tolerate delayed indexing without creating a fallback tag", async () => {
  const { store, mock, subject } = await fixture(); mock.acknowledgeSubjects = true;
  const item = await artifact(store, subject, "application/spdx+json", {}); let reads = 0;
  const publisher = new Publisher("registry.test/demo", { credentials: async () => undefined, sleep: async () => {}, fetcher: async (url, init) => {
    if (new URL(url).pathname.includes("/referrers/")) return Response.json({ mediaType: media.index, manifests: ++reads < 3 ? [] : [item.manifest] });
    return mock.fetch(url, init);
  } });
  await publishArtifacts(publisher, store, [item]);
  expect(reads).toBe(3);
  expect(mock.manifests.has(`registry.test/demo/${subject.digest.replace(":", "-")}`)).toBe(false);
});
