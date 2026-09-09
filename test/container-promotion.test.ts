import { expect, test } from "bun:test";
import { promoteContainer } from "../scripts/promote-container.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { media } from "../packages/oci/types.ts";
import { MockRegistry } from "./mock-registry.ts";

function fixture(architectures: readonly string[] = ["amd64", "arm64"]) {
  const registry = new MockRegistry(), repository = "registry.example/team/cli";
  const manifests = architectures.map((architecture) => {
    const bytes = Buffer.from(JSON.stringify({ architecture })), digest = sha256(bytes);
    registry.manifests.set(`${repository}/${digest}`, { bytes, type: media.manifest });
    return { mediaType: media.manifest, digest, size: bytes.length, platform: { os: "linux", architecture } };
  });
  const attestation = Buffer.from('{}'), attestationDigest = sha256(attestation);
  registry.manifests.set(`${repository}/${attestationDigest}`, { bytes: attestation, type: media.manifest });
  manifests.push({ mediaType: media.manifest, digest: attestationDigest, size: attestation.length, platform: { os: "unknown", architecture: "unknown" } });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests, annotations: { fixture: "preserve bytes and attestations" } }, null, 2));
  const digest = sha256(bytes); registry.manifests.set(`${repository}/${digest}`, { bytes, type: media.index });
  return { registry, repository, bytes, digest, options: { fetcher: registry.fetch, credentials: async () => undefined, sleep: async () => {} } };
}

test("container promotion preserves the tested index and attestation descriptors byte for byte", async () => {
  const f = fixture();
  await promoteContainer(f.repository, f.digest, "0.1.0-rc.5", f.options);
  expect(f.registry.manifests.get(`${f.repository}/v0.1.0-rc.5`)?.bytes).toEqual(f.bytes);
  expect(f.registry.requests.filter((r) => r.method === "PUT").map((r) => r.url.pathname)).toEqual(["/v2/team/cli/manifests/v0.1.0-rc.5"]);
});

test("container promotion refuses existing version tags even for the same digest", async () => {
  const f = fixture();
  f.registry.manifests.set(`${f.repository}/v0.1.0-rc.5`, { bytes: f.bytes, type: media.index });
  await expect(promoteContainer(f.repository, f.digest, "v0.1.0-rc.5", f.options)).rejects.toThrow("already exists");
  expect(f.registry.requests.some((r) => r.method === "PUT")).toBe(false);
});

test.each([{ architectures: ["amd64"] }, { architectures: ["amd64", "arm64", "arm64"] }])("container promotion rejects incomplete or ambiguous platforms", async ({ architectures }) => {
  const f = fixture(architectures);
  await expect(promoteContainer(f.repository, f.digest, "v0.1.0-rc.5", f.options)).rejects.toThrow("exactly one");
  expect(f.registry.requests.some((r) => r.method === "PUT")).toBe(false);
});

test("container promotion fails closed on digest mismatch and publication denial", async () => {
  const f = fixture();
  const bad = sha256(Buffer.from("wrong")); f.registry.manifests.set(`${f.repository}/${bad}`, { bytes: f.bytes, type: media.index });
  await expect(promoteContainer(f.repository, bad, "v0.1.0-rc.5", f.options)).rejects.toThrow("digest mismatch");
  f.registry.failTag = "v0.1.0-rc.5";
  await expect(promoteContainer(f.repository, f.digest, "v0.1.0-rc.5", f.options)).rejects.toThrow("403");
  expect(f.registry.manifests.has(`${f.repository}/v0.1.0-rc.5`)).toBe(false);
});


test("container promotion rejects malformed digests before network access", async () => {
  const f = fixture();
  await expect(promoteContainer(f.repository, "sha256:invalid", "v0.1.0-rc.5", f.options)).rejects.toThrow();
  expect(f.registry.requests).toHaveLength(0);
});

test("container promotion preserves Docker manifest lists without converting media types", async () => {
  const f = fixture();
  const bytes = Buffer.from(f.bytes.toString().replace(media.index, media.dockerIndex)), digest = sha256(bytes);
  f.registry.manifests.set(`${f.repository}/${digest}`, { bytes, type: media.dockerIndex });
  await promoteContainer(f.repository, digest, "v0.1.0-rc.5", f.options);
  expect(f.registry.manifests.get(`${f.repository}/v0.1.0-rc.5`)).toEqual({ bytes, type: media.dockerIndex });
});
