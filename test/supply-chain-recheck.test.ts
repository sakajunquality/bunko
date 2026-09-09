import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { baseInventory, imageMetadata } from "../packages/bunko/metadata.ts";
import { revisionTag } from "../packages/bunko/source-metadata.ts";
import { sbomType } from "../packages/bunko/attest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { LayoutSource } from "../packages/oci/source.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { media } from "../packages/oci/types.ts";
import { baseLayout, project, readJSON, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await temporary(); roots.push(root); return root; }

test("base annotations name the exact platform manifest and source index", async () => {
  const root = await fixture(), base = await baseLayout(join(root, "base")), source = await project(join(root, "source"));
  const store = new BlobStore(base), baseRoot = await new LayoutSource(base).root(); await store.put(baseRoot.bytes, baseRoot.descriptor.mediaType);
  const mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  await new Publisher("registry.example/base", registry).publish(store, baseRoot.descriptor, []);
  const result = await build({ path: source, base: `registry.example/base@${baseRoot.descriptor.digest}`, output: join(root, "image"), push: false, localCache: false, gitMetadata: false, registry });
  const index = await readJSON<any>(result.layout!, result.root), manifest = await readJSON<any>(result.layout!, result.manifest);
  expect(index.annotations["org.opencontainers.image.base.digest"]).toBe(baseRoot.descriptor.digest);
  expect(index.annotations["org.opencontainers.image.base.name"]).toBe(`registry.example/base@${baseRoot.descriptor.digest}`);
  expect(manifest.annotations["org.opencontainers.image.base.digest"]).toBe(result.images[0]!.baseDigest);
  expect(manifest.annotations["org.opencontainers.image.base.name"]).toBe(`registry.example/base@${result.images[0]!.baseDigest}`);
  await expect(build({ path: source, baseLayout: base, push: false, imageAnnotations: { "org.opencontainers.image.base.digest": "fake" } })).rejects.toThrow("reserved");
});

test("offline builds link local SPDX layouts without putting host paths into provenance", async () => {
  const root = await fixture(), source = await project(join(root, "source")), output = join(root, "base-image");
  const base = await build({ path: source, baseLayout: await baseLayout(join(root, "base")), output, push: false, localCache: false, gitMetadata: false, sbom: true });
  const metadata = await baseInventory(`layout:${output}`, [base.manifest.digest], { fetcher: async () => { throw new Error("Unexpected registry request"); } });
  expect(metadata.reference).toBe(`urn:bunko:base-sbom:${metadata.manifest.digest}`);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "linked", module: "src/server.ts", bunko: { workdir: "/derived-app" } }));
  const linked = await build({ path: source, baseLayout: output, output: join(root, "linked"), offline: true, push: false, localCache: false, gitMetadata: false, sbom: true, provenance: true, baseSBOMs: { "linux/amd64": `layout:${output}` } });
  expect(linked.images[0]!.baseInventory?.reference).toBe(metadata.reference);
  const documents = await imageMetadata(`layout:${linked.layout}`);
  expect(JSON.stringify(documents.map((record) => record.document))).not.toContain(root);
  expect((await readJSON<any>(linked.layout!, linked.manifest)).annotations["org.opencontainers.image.base.name"]).toBeUndefined();
  await expect(baseInventory(`layout:${output}`, [`sha256:${"f".repeat(64)}`], {})).rejects.toThrow("subject");
});

test("base SPDX accepts JSON configs and a supported payload alongside unrelated layers", async () => {
  const root = await fixture(), store = new BlobStore(root), subject = { mediaType: media.manifest, digest: `sha256:${"a".repeat(64)}`, size: 123 };
  const config = await store.put(canonicalJSON({ tool: "fixture" }), "application/vnd.example.config.v1+json");
  const payload = await store.put(canonicalJSON({ spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", documentNamespace: "urn:fixture:spdx", packages: [{ SPDXID: "SPDXRef-Base" }], documentDescribes: ["SPDXRef-Base"] }), sbomType);
  const extra = await store.put(Buffer.from("optional text"), "text/plain");
  const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType: "application/vnd.example.inventory", subject, config, layers: [extra, payload] }), media.manifest);
  await writeFile(join(root, "oci-layout"), canonicalJSON({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(root, "index.json"), canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [manifest] }));
  expect((await baseInventory(`layout:${root}`, [subject.digest], {})).described).toEqual(["SPDXRef-Base"]);
  const duplicate = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType: sbomType, subject, config, layers: [payload, payload] }), media.manifest);
  await writeFile(join(root, "index.json"), canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [duplicate] }));
  await expect(baseInventory(`layout:${root}`, [subject.digest], {})).rejects.toThrow("exactly one");
});

test("unknown Git dirty state never produces a clean-looking revision tag", () => {
  const revision = { "org.opencontainers.image.revision": "a".repeat(40) };
  expect(revisionTag(revision)).toBeUndefined();
  expect(revisionTag({ ...revision, "org.bunko.git.dirty": "false" })).toBe("a".repeat(12));
  expect(revisionTag({ ...revision, "org.bunko.git.dirty": "true" })).toBe(`${"a".repeat(12)}-dirty`);
});
