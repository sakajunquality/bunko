import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { build } from "../packages/bunko/build.ts";
import { provenanceType, sbomType, signImages, verifyImage, signingEnvironment } from "../packages/bunko/attest.ts";
import { checkBase } from "../packages/bunko/check-base.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { LayoutSource, resolveBase } from "../packages/oci/source.ts";
import { artifact, publishArtifacts } from "../packages/oci/artifacts.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }

test("SBOM and provenance describe exact subjects without changing runnable identity", async () => {
  const root = await fixture(), f = await dependencyFixture(root, false), base = await baseLayout(join(root, "base"));
  const options = { path: f.source, baseLayout: base, push: false, localCache: false, gitMetadata: false, installCache: f.cache };
  const plain = await build({ ...options, output: join(root, "plain") });
  const output = join(root, "image");
  const result = await build({ ...options, sbom: true, provenance: true, output, verifyDeterministic: true });
  expect(result.root).toEqual(plain.root);
  expect(result.attestations).toHaveLength(2);
  const store = new BlobStore(output);
  for (const item of result.attestations!) {
    const manifest = JSON.parse(Buffer.from(await store.read(item.manifest)).toString());
    expect(manifest.subject).toEqual(item.subject);
    const payload = JSON.parse(Buffer.from(await store.read(manifest.layers[0])).toString());
    if (manifest.artifactType === sbomType) {
      expect(payload.spdxVersion).toBe("SPDX-2.3");
      expect(payload.packages.map((p: { name: string }) => p.name)).toEqual(["hello", "fixture-msg", "bun"]);
      expect(payload.packages.at(-1).comment).toContain("Expected base");
      expect(item.subject.digest).toBe(result.manifest.digest);
    } else {
      expect(manifest.artifactType).toBe(provenanceType);
      expect(payload.subject[0].digest.sha256).toBe(result.root.digest.slice(7));
      expect(payload.predicate.runDetails.builder.builderDependencies[0].digest.sha256).toBe(result.builder!.digest.slice(7));
      expect(result.toolchain.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(payload.predicate.buildDefinition.resolvedDependencies.some((d: { uri: string }) => d.uri === "urn:bunko:lock")).toBe(true);
    }
    expect(JSON.stringify(payload)).not.toContain(root);
    expect(JSON.stringify(payload)).not.toContain("fixture-dev");
  }
  const resolved = await resolveBase(new LayoutSource(output), { os: "linux", architecture: "amd64" }, new BlobStore(join(root, "read")), true);
  expect(resolved.descriptor.digest).toBe(result.manifest.digest);
});

test("referrers fallback retains both artifact types and repeated publication is idempotent", async () => {
  const root = await fixture(), store = new BlobStore(root), mock = new MockRegistry();
  const subject = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"a".repeat(64)}` as const, size: 123 };
  const first = await artifact(store, subject, sbomType, { spdxVersion: "SPDX-2.3" });
  const second = await artifact(store, subject, provenanceType, { predicateType: "https://slsa.dev/provenance/v1" });
  const publisher = new Publisher("registry.test/demo", { fetcher: mock.fetch, credentials: async () => undefined });
  await publishArtifacts(publisher, store, [first, second, first]);
  const fallback = mock.manifests.get(`registry.test/demo/${subject.digest.replace(":", "-")}`)!;
  expect(JSON.parse(Buffer.from(fallback.bytes).toString()).manifests).toHaveLength(2);
});

test("signing pins digests, disables transparency upload and propagates failure", async () => {
  const root = await fixture(), log = join(root, "args.json"), exe = join(root, "cosign");
  await writeFile(exe, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
  const reference = `registry.test/private@sha256:${"a".repeat(64)}`;
  await signImages([reference], "private.key", exe);
  expect(JSON.parse(await readFile(log, "utf8"))).toEqual(["sign", "--yes", "--key", "private.key", "--use-signing-config=false", "--tlog-upload=false", reference]);
  await writeFile(exe, `#!${process.execPath}\nprocess.exit(1);`, { mode: 0o755 });
  await expect(signImages([reference], "private.key", exe)).rejects.toThrow("cosign sign failed");
  await expect(verifyImage("registry.test/private:latest", "public.key", true, exe)).rejects.toThrow("immutable");
});

test("base metadata inspection does not claim runtime verification", async () => {
  const root = await fixture(), base = await baseLayout(join(root, "base"));
  const result = await checkBase({ baseLayout: base });
  expect(result.platforms[0]!.runtimeVerified).toBe(false);
  expect(result.platforms[0]!.user).toBe("65532:65532");
  await expect(checkBase({ baseLayout: base, platform: "linux/arm64" })).rejects.toThrow("Expected exactly one base");
});

test("attachment failure records an incomplete supply-chain phase after image publication", async () => {
  const root = await fixture(), f = await dependencyFixture(root, false), base = await baseLayout(join(root, "base"));
  const mock = new MockRegistry(), report = join(root, "failed.json");
  await expect(build({ path: f.source, baseLayout: base, repo: "registry.test/demo", bare: true, sbom: true, report,
    installCache: f.cache, localCache: false, registryCache: false, registry: { credentials: async () => undefined,
      fetcher: async (url, init) => String(url).includes("/referrers/") ? new Response(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] })) : mock.fetch(url, init) },
  })).rejects.toThrow("did not retain");
  const result = JSON.parse(await readFile(report, "utf8"));
  expect(result.publication.published).toBe(true);
  expect(result.status).toBe("failed");
  expect(result.supplyChain.status).toBe("attaching");
});

test("cosign environment cannot redirect signatures or public service configuration", () => {
  const old = process.env.COSIGN_REPOSITORY;
  process.env.COSIGN_REPOSITORY = "public.example/leak";
  try { expect(signingEnvironment().COSIGN_REPOSITORY).toBeUndefined(); }
  finally { if (old === undefined) delete process.env.COSIGN_REPOSITORY; else process.env.COSIGN_REPOSITORY = old; }
});

test("referrer verification follows same-subject pages and rejects foreign pagination", async () => {
  const root = await fixture(), store = new BlobStore(root), mock = new MockRegistry();
  const subject = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"b".repeat(64)}` as const, size: 123 };
  const item = await artifact(store, subject, sbomType, {});
  let foreign = false;
  const publisher = new Publisher("registry.test/demo", { credentials: async () => undefined, fetcher: async (input, init) => {
    const url = new URL(input);
    if (!url.pathname.includes("/referrers/")) return mock.fetch(input, init);
    if (url.searchParams.has("page")) return new Response(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [item.manifest] }));
    return new Response(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }), {
      headers: { Link: `<${foreign ? "https://foreign.test" : ""}${url.pathname}?page=2>; rel="next"` },
    });
  } });
  await publishArtifacts(publisher, store, [item]);
  foreign = true;
  await expect(publishArtifacts(publisher, store, [item])).rejects.toThrow("escaped");
});

test("SPDX namespaces identify document content and provenance names the image repository without argument values", async () => {
  const { spdx, provenance } = await import("../packages/bunko/attest.ts");
  const { sha256, canonicalJSON } = await import("../packages/oci/digest.ts");
  const root = await fixture(), f = await dependencyFixture(root, false);
  const result = await build({ path: f.source, baseLayout: await baseLayout(join(root, "base")), output: join(root, "image"), repo: "registry.example/team/app", push: false, localCache: false, gitMetadata: false, installCache: f.cache,
    define: { PUBLIC_FLAG: '"SECRET_DEFINE"' }, runtimeArgs: ["--title=SECRET_RUNTIME"] });
  const document = spdx("fixture", result.images[0]!, 0);
  const { documentNamespace, ...content } = document;
  expect(documentNamespace).toBe(`urn:bunko:spdx:${sha256(canonicalJSON(content))}`);
  expect(spdx("fixture", result.images[0]!, 0).documentNamespace).toBe(documentNamespace);
  expect(spdx("fixture", { ...result.images[0]!, bundledInventory: [{ name: "another-package", version: "1.0.0", path: "node_modules/another-package" }] }, 0).documentNamespace).not.toBe(documentNamespace);
  const statement = provenance(result);
  expect(statement.subject[0]!.name).toBe("registry.example/team/app/hello");
  expect(provenance({ ...result, imageRepository: undefined }).subject[0]!.name).toBe("bunko.local/hello");
  expect(statement.predicate.buildDefinition.externalParameters.defineKeys).toEqual(["PUBLIC_FLAG"]);
  expect(statement.predicate.buildDefinition.externalParameters.runtime?.argumentCount).toBe(1);
  expect(statement.predicate.buildDefinition.externalParameters.runtime?.argumentsDigest).toBe(sha256(canonicalJSON(["--title=SECRET_RUNTIME"])));
  expect(JSON.stringify(statement)).not.toContain("SECRET_DEFINE"); expect(JSON.stringify(statement)).not.toContain("SECRET_RUNTIME"); expect(JSON.stringify(statement)).not.toContain(root);
});
