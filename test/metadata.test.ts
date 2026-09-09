import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { build } from "../packages/bunko/build.ts";
import { imageMetadata, exportMetadata, baseInventory } from "../packages/bunko/metadata.ts";
import { supplyChainOptions } from "../packages/bunko/policy.ts";
import { packageLicense } from "../packages/bunko/inventory.ts";
import { sbomType } from "../packages/bunko/attest.ts";
import { resolveDocuments } from "../packages/bunko/resolve.ts";
import { pushLayout } from "../packages/bunko/push-layout.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }

test("metadata exports exact payload bytes from layouts and registry referrer fallback", async () => {
  const root = await fixture(), source = await project(join(root, "source")), output = join(root, "image");
  const result = await build({ path: source, baseLayout: await baseLayout(join(root, "base")), output, push: false, localCache: false, sbom: true, provenance: true });
  const records = await imageMetadata(`layout:${output}`);
  expect(records).toHaveLength(2);
  const exported = await exportMetadata(`layout:${output}`, join(root, "metadata"));
  for (const item of exported.records) expect(sha256(await readFile(join(exported.directory, item.file)))).toBe(item.payload.digest);
  await expect(exportMetadata(`layout:${output}`, exported.directory)).rejects.toThrow("already exists");
  const mock = new MockRegistry(), registry = { fetcher: mock.fetch, credentials: async () => undefined };
  const publication = await pushLayout(output, "registry.test/metadata", [], registry);
  const remote = await imageMetadata(publication.reference, registry);
  expect(remote.map((r) => r.payload.digest)).toEqual(records.map((r) => r.payload.digest));
  let crossed = false;
  const api = { ...registry, fetcher: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (!url.pathname.includes("/referrers/")) return mock.fetch(input, init);
    const subject = url.pathname.split("/").at(-1)!;
    if (!url.searchParams.has("page")) return new Response(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }), { headers: { Link: `<${url.pathname}?page=2>; rel="next"` } });
    return new Response(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: remote.filter((r) => crossed ? r.subject.digest !== subject : r.subject.digest === subject).map((r) => ({ ...r.manifest, artifactType: r.payload.mediaType })) }));
  } };
  expect((await imageMetadata(publication.reference, api)).map((r) => r.payload.digest)).toEqual(remote.map((r) => r.payload.digest));
  crossed = true;
  await expect(imageMetadata(publication.reference, api)).rejects.toThrow("subject");
  const sbom = remote.find((r) => r.payload.mediaType === sbomType)!;
  const reference = `registry.test/metadata@${sbom.manifest.digest}`;
  expect((await baseInventory(reference, [result.manifest.digest], registry)).payload.digest).toBe(sbom.payload.digest);
  await expect(baseInventory(reference, [`sha256:${"f".repeat(64)}`], registry)).rejects.toThrow("subject");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "hello", module: "src/server.ts", type: "module", bunko: { workdir: "/derived-app" } }));
  const linked = await build({ path: source, baseLayout: output, output: join(root, "linked"), push: false, localCache: false, sbom: true, provenance: true,
    baseSBOMs: { "linux/amd64": reference }, registry });
  const linkedMetadata = await imageMetadata(`layout:${join(root, "linked")}`);
  const linkedSBOM = linkedMetadata.find((r) => r.payload.mediaType === sbomType)!.document;
  expect(linkedSBOM.externalDocumentRefs).toEqual([{ externalDocumentId: "DocumentRef-Base", spdxDocument: sbom.document.documentNamespace, checksum: { algorithm: "SHA256", checksumValue: sbom.payload.digest.slice(7) } }]);
  expect(linkedSBOM.relationships).toContainEqual({ spdxElementId: "SPDXRef-Image", relationshipType: "CONTAINS", relatedSpdxElement: "DocumentRef-Base:SPDXRef-Image" });
  expect(linked.images[0]!.baseInventory!.artifactDigest).toBe(sbom.manifest.digest);
  await expect(imageMetadata("registry.test/metadata:latest", registry)).rejects.toThrow("digest-pinned");
  await writeFile(join(output, "blobs/sha256", records[0]!.payload.digest.slice(7)), "corrupt");
  await expect(exportMetadata(`layout:${output}`, join(root, "failed"))).rejects.toThrow();
  expect(await Bun.file(join(root, "failed/index.json")).exists()).toBe(false);
});

test("CI policy is explicit and validated even when documents contain no build references", async () => {
  expect(supplyChainOptions({ supplyChainPolicy: "ci", reproducible: true, signKey: "key" })).toMatchObject({ sbom: true, provenance: true });
  for (const options of [ {}, { reproducible: true }, { reproducible: true, signKey: "key", sbom: false } ]) {
    expect(() => supplyChainOptions({ ...options, supplyChainPolicy: "ci" })).toThrow("CI policy requires");
  }
  expect(() => supplyChainOptions({ supplyChainPolicy: "ci", reproducible: true, signKey: "key", externalDeps: {} })).toThrow("deps-verify-key");
  expect(() => supplyChainOptions({ depsVerifyKey: "key" })).toThrow("prepared dependencies");
  const root = await fixture(), yaml = join(root, "config.yaml"); await writeFile(yaml, "kind: ConfigMap\n");
  await expect(resolveDocuments({ files: [yaml], supplyChainPolicy: "ci" })).rejects.toThrow("CI policy requires");
  expect(packageLicense("MIT")).toBe("MIT");
  expect(packageLicense("(MIT OR Apache-2.0)")).toBeUndefined();
  expect(packageLicense({ type: "MIT" })).toBeUndefined();
});

test("signing keys are excluded from snapshots and rejected inside required assets", async () => {
  const root = await fixture(), source = await project(join(root, "source"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(source, "bunkodata"));
  const key = join(source, "bunkodata/signing.key"), exe = join(root, "cosign");
  await writeFile(key, "private signing material one");
  await writeFile(exe, `#!${process.execPath}\nif (process.argv[2] === "version") console.log(JSON.stringify({gitVersion:"v3.1.3"}));\nprocess.exit(0);`, { mode: 0o755 });
  const mock = new MockRegistry(), options = { path: source, baseLayout: await baseLayout(join(root, "base")), repo: "registry.test/signed", bare: true,
    localCache: false, registryCache: false, gitMetadata: false, signKey: key, cosignPath: exe, registry: { fetcher: mock.fetch, credentials: async () => undefined } };
  await expect(build(options)).rejects.toThrow("exclusion overlaps bunkodata");
  await rm(key);
  options.signKey = join(source, "signing.key");
  await writeFile(options.signKey, "private signing material one");
  const first = await build(options);
  await writeFile(options.signKey, "private signing material two");
  const second = await build(options);
  expect(second.sourceDigest).toBe(first.sourceDigest);
  expect(second.root.digest).toBe(first.root.digest);

});

test("foreign metadata is reported as skipped while wrong artifact subjects remain fatal", async () => {
  const { artifact } = await import("../packages/oci/artifacts.ts"), { BlobStore } = await import("../packages/oci/blob-store.ts");
  const root = await fixture(), output = join(root, "image");
  const result = await build({ path: await project(join(root, "source")), baseLayout: await baseLayout(join(root, "base")), output, push: false, localCache: false, sbom: true });
  const store = new BlobStore(output), indexPath = join(output, "index.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
  const foreign = await artifact(store, result.manifest, "application/vnd.in-toto+json", { _type: "https://in-toto.io/Statement/v1", predicateType: "https://example.test/predicate" });
  const older = await artifact(store, result.manifest, sbomType, { spdxVersion: "SPDX-2.2" });
  index.manifests.push(foreign.manifest, older.manifest); await writeFile(indexPath, JSON.stringify(index));
  const exported = await exportMetadata(`layout:${output}`, join(root, "exported"));
  expect(exported.records).toHaveLength(1); expect(exported.skipped).toHaveLength(2);
  const wrong = await artifact(store, { ...result.manifest, digest: `sha256:${"f".repeat(64)}` }, sbomType, { spdxVersion: "SPDX-2.2" });
  index.manifests.push(wrong.manifest); await writeFile(indexPath, JSON.stringify(index));
  await expect(exportMetadata(`layout:${output}`, join(root, "wrong"))).rejects.toThrow("subject mismatch");
});
