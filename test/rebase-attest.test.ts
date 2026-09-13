import { expect, test } from "bun:test";
import { rebaseProvenance, rebaseSpdx } from "../packages/bunko/rebase-attest.ts";
import { sha256 } from "../packages/oci/digest.ts";
import type { Descriptor, Digest, Platform } from "../packages/oci/types.ts";

const d = (letter: string): Digest => `sha256:${letter.repeat(64)}` as Digest;
const descriptor = (letter: string): Descriptor => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: d(letter), size: 1 });
const platform: Platform = { os: "linux", architecture: "amd64" };
function original() {
  return {
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", documentNamespace: "urn:old", creationInfo: { creators: ["Tool: bunko-0.7.0"] },
    packages: [
      { SPDXID: "SPDXRef-Image", name: "app", versionInfo: d("a"), licenseDeclared: "NOASSERTION" },
      { SPDXID: `SPDXRef-Package-${sha256("left-pad@1.3.0").slice(7)}`, name: "left-pad", versionInfo: "1.3.0", licenseDeclared: "MIT", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/left-pad@1.3.0" }] },
      { SPDXID: "SPDXRef-Bun-Runtime", name: "bun", versionInfo: "1.4.0", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:generic/bun@1.4.0" }] },
    ],
    files: [{ SPDXID: "SPDXRef-Bun-Executable", fileName: "/usr/local/bin/bun", fileTypes: ["BINARY"], checksums: [{ algorithm: "SHA256", checksumValue: "b".repeat(64) }], licenseConcluded: "MIT" }],
    externalDocumentRefs: [{ externalDocumentId: "DocumentRef-Old", spdxDocument: "urn:old-base" }],
    relationships: [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Image" }, { spdxElementId: "SPDXRef-Image", relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Bun-Runtime" }, { spdxElementId: "SPDXRef-Image", relationshipType: "CONTAINS", relatedSpdxElement: "DocumentRef-Old:SPDXRef-Package-Old" }],
  };
}

test("rebase SPDX rebuilds a fresh document and preserves application and Bun inventory", () => {
  const result = rebaseSpdx(original(), descriptor("a"), descriptor("c"), platform, 0, { namespace: "urn:new-base", digest: d("e"), described: ["SPDXRef-Package-Base"] }) as any;
  expect(result.spdxVersion).toBe("SPDX-2.3");
  expect(result.packages.map((p: any) => p.SPDXID)).toEqual(["SPDXRef-Image", `SPDXRef-Package-${sha256("left-pad@1.3.0").slice(7)}`, "SPDXRef-Bun-Runtime"]);
  expect(result.packages[0].versionInfo).toBe(d("c"));
  expect(result.files[0].SPDXID).toBe("SPDXRef-Bun-Executable");
  expect(result.externalDocumentRefs[0].spdxDocument).toBe("urn:new-base");
  expect(JSON.stringify(result)).not.toContain("old-base");
  expect(result.comment).toContain("no source build or rescan");
  expect(result.documentNamespace).toBe((rebaseSpdx(original(), descriptor("a"), descriptor("c"), platform, 0, { namespace: "urn:new-base", digest: d("e"), described: ["SPDXRef-Package-Base"] }) as any).documentNamespace);
});

test("rebase SPDX rejects an unrecognized document or mismatched original subject", () => {
  expect(() => rebaseSpdx({ spdxVersion: "SPDX-2.2" }, descriptor("a"), descriptor("c"), platform, 0)).toThrow();
  expect(() => rebaseSpdx(original(), descriptor("b"), descriptor("c"), platform, 0)).toThrow("subject mismatch");
});

test("rebase provenance identifies the rebase build and its materials", () => {
  const result = rebaseProvenance({ source: descriptor("a"), root: descriptor("c"), platforms: [{ platform, oldBase: d("b"), newBase: d("d"), preservedLayers: [d("f")], policy: "strict" }], builder: { kind: "builder", digest: d("1") }, policyDigest: d("2"), inventoryDigests: [d("3")] }) as any;
  expect(result.subject[0].digest.sha256).toBe(d("c").slice(7));
  expect(result.predicate.buildDefinition.buildType).toContain("/rebase/v1");
  const uris = result.predicate.buildDefinition.resolvedDependencies.map((m: any) => m.uri);
  expect(uris).toEqual(expect.arrayContaining(["urn:bunko:rebase:original-image", "urn:bunko:rebase:old-base:linux/amd64", "urn:bunko:rebase:new-base:linux/amd64", "urn:bunko:rebase:policy", "urn:bunko:rebase:inventory:0"]));
  expect(JSON.stringify(result)).not.toContain("build/v1");
});
