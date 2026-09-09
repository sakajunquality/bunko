import { packageLicense } from "./inventory.ts";
import { assertCosign, cosignCommand } from "./cosign.ts";
export { signingEnvironment } from "./cosign.ts";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import type { BuildResult, PlatformResult } from "./build.ts";
import type { InventoryEntry } from "./deps.ts";
import { parseReference } from "../oci/source.ts";
import { VERSION } from "./config.ts";

export const sbomType = "application/spdx+json";
export const provenanceType = "application/vnd.in-toto+json";

export function spdx(name: string, image: PlatformResult, timestamp: number, runtime?: { version: string; revision: string; embedded: boolean }) {
  const release = image.runtime ?? image.compileRuntime;
  const inventory = new Map<string, InventoryEntry>();
  for (const item of [...image.inventory, ...image.bundledInventory ?? []]) inventory.set(`${item.name}@${item.version}`, item);
  const packages = [...inventory.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)).map((item) => ({
    SPDXID: `SPDXRef-Package-${sha256(Buffer.from(`${item.name}@${item.version}`)).slice(7)}`,
    name: item.name, versionInfo: item.version, downloadLocation: "NOASSERTION", filesAnalyzed: false,
    licenseConcluded: "NOASSERTION", licenseDeclared: packageLicense(item.license) ?? "NOASSERTION", copyrightText: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl",
      referenceLocator: `pkg:npm/${item.name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(item.version)}` }],
  }));
  const root = { SPDXID: "SPDXRef-Image", name, versionInfo: image.manifest.digest, downloadLocation: "NOASSERTION",
    filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION" };
  const document = { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `${name}-${image.platform.architecture}`,
    creationInfo: { creators: [`Tool: bunko-${VERSION}`], created: new Date(timestamp * 1000).toISOString().replace(".000Z", "Z") },
    comment: "Application package inventory from bundled inputs and runtime dependencies. Base OS packages are represented only by an explicitly linked external document, when supplied. Undeclared runtime-loaded packages are not inventoried. Unknown license declarations are not inferred.",
    ...(image.baseInventory ? { externalDocumentRefs: [{ externalDocumentId: "DocumentRef-Base", spdxDocument: image.baseInventory.namespace, checksum: { algorithm: "SHA256", checksumValue: image.baseInventory.digest.slice(7) } }] } : {}),
    ...(image.runtime ? { files: [{ SPDXID: "SPDXRef-Bun-Executable", fileName: image.runtime.path, fileTypes: ["BINARY"], checksums: [{ algorithm: "SHA256", checksumValue: image.runtime.executableDigest.slice(7) }], licenseConcluded: "NOASSERTION", licenseInfoInFiles: ["NOASSERTION"], copyrightText: "NOASSERTION" }] } : {}),
    packages: [root, ...packages, ...(runtime ? [{ SPDXID: "SPDXRef-Bun-Runtime", name: "bun", versionInfo: runtime.version, downloadLocation: release?.url ?? "NOASSERTION", ...(release ? { checksums: [{ algorithm: "SHA256", checksumValue: release.archiveDigest.slice(7) }] } : {}), filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION", comment: release ? `${image.compileRuntime ? "Embedded" : "Injected"} signed release; policy ${release.policy}; signer ${release.signer}; release revision ${release.releaseRevision}; runtime execution not verified` : `${runtime.embedded ? "Embedded" : "Expected base"} Bun runtime revision ${runtime.revision}; custom base runtime identity is not independently verified`, externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:generic/bun@${runtime.version}` }] }] : [])], relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: root.SPDXID },
      ...(image.runtime ? [{ spdxElementId: root.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Bun-Executable" }, { spdxElementId: "SPDXRef-Bun-Executable", relationshipType: "GENERATED_FROM", relatedSpdxElement: "SPDXRef-Bun-Runtime" }] : []),
      ...(runtime ? [{ spdxElementId: root.SPDXID, relationshipType: runtime.embedded || image.runtime ? "CONTAINS" : "DEPENDS_ON", relatedSpdxElement: "SPDXRef-Bun-Runtime" }] : []),
      ...(image.baseInventory?.described.map((id) => ({ spdxElementId: root.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: `DocumentRef-Base:${id}` })) ?? []),
      ...packages.map((p) => ({ spdxElementId: root.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: p.SPDXID })),
    ] };
  return { ...document, documentNamespace: `urn:bunko:spdx:${sha256(canonicalJSON(document))}` };
}

export function provenance(result: BuildResult, lockDigest?: string) {
  const dependency = (uri: string, digest: string) => ({ uri, digest: { sha256: digest.slice(7) } });
  return { _type: "https://in-toto.io/Statement/v1", subject: [{ name: result.imageRepository ?? `bunko.local/${result.target}`, digest: { sha256: result.root.digest.slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1", predicate: {
      buildDefinition: { buildType: "https://github.com/sakajunquality/bunko/build/v1",
        externalParameters: { ...result.buildParameters, platforms: result.images.map((image) => image.platform), mode: result.mode ?? "bundle", ...(result.assetMaterials ? { assetMappings: result.assetMaterials.map(({ digest, ...mapping }) => mapping) } : {}) },
        internalParameters: { builder: result.builder }, resolvedDependencies: [dependency("urn:bunko:source", result.sourceDigest),
          ...(result.runtimeCA ? [dependency("urn:bunko:runtime-ca", result.runtimeCA.digest)] : []),
          ...(result.assetMaterials ?? []).map((material, index) => dependency(`urn:bunko:asset:${material.context}:${index}`, material.digest)),
          ...(lockDigest ? [dependency("urn:bunko:lock", lockDigest)] : []),
          ...result.images.flatMap((image) => { const release = image.runtime ?? image.compileRuntime; return release ? [dependency(release.url, release.archiveDigest), { ...dependency(release.url.replace(/\/[^/]+$/, "/SHASUMS256.txt.asc"), release.checksumDocumentDigest), annotations: { signer: release.signer, policy: release.policy } }] : []; }),
          ...result.images.map((image) => dependency(`urn:bunko:base:${image.platform.architecture}`, image.baseDigest)),
          ...result.images.flatMap((image) => image.baseInventory ? [dependency(`oci://${image.baseInventory.reference}`, image.baseInventory.artifactDigest)] : []),
          ...result.images.flatMap((image) => image.dependencyArtifact ? [dependency(`urn:bunko:dependencies:${image.platform.architecture}`, image.dependencyArtifact)] : []),
          { uri: `https://github.com/oven-sh/bun/tree/${result.toolchain.revision}`, ...(result.toolchain.digest ? { digest: { sha256: result.toolchain.digest.slice(7) } } : {}), annotations: { version: result.toolchain.version } },
        ] },
      runDetails: { builder: { id: `https://github.com/sakajunquality/bunko`, ...(result.builder ? { builderDependencies: [{ uri: `urn:bunko:builder:${result.builder.kind}`, digest: { sha256: result.builder.digest.slice(7) } }] } : {}) }, metadata: {} },
    } };
}

export async function signImages(references: string[], key: string, executable = "cosign", insecure: string[] = []): Promise<void> {
  const images = [...new Set(references)].map((reference) => {
    const ref = parseReference(reference);
    if (!ref.reference.startsWith("sha256:")) throw new Error("Signing requires an immutable image@digest");
    return { reference, ref };
  });
  if (!images.length) return;
  await assertCosign(executable);
  for (const { reference, ref } of images) {
    // Key-based signatures stay in the selected registry. Never submit to Rekor.
    await cosignCommand(executable, ["sign", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false",
      ...(insecure.includes(ref.registry) ? ["--allow-http-registry"] : []), reference]);
  }
}

export async function verifyImage(reference: string, key: string, privateSignatures = false, executable = "cosign", insecure: string[] = []): Promise<void> {
  const ref = parseReference(reference);
  if (!ref.reference.startsWith("sha256:")) throw new Error("Signature verification requires an immutable image@digest");
  await assertCosign(executable);
  await cosignCommand(executable, ["verify", "--key", key, ...(privateSignatures ? ["--insecure-ignore-tlog=true"] : []),
    ...(insecure.includes(ref.registry) ? ["--allow-http-registry"] : []), reference]);
}
