import { sha256 } from "../oci/digest.ts";
import type { BuildResult, PlatformResult } from "./build.ts";
import type { InventoryEntry } from "./deps.ts";
import { parseReference } from "../oci/source.ts";
import { VERSION } from "./config.ts";

export const sbomType = "application/spdx+json";
export const provenanceType = "application/vnd.in-toto+json";

export function spdx(name: string, image: PlatformResult, timestamp: number) {
  const inventory = new Map<string, InventoryEntry>();
  for (const item of [...image.inventory, ...image.bundledInventory ?? []]) inventory.set(`${item.name}@${item.version}`, item);
  const packages = [...inventory.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)).map((item) => ({
    SPDXID: `SPDXRef-Package-${sha256(Buffer.from(`${item.name}@${item.version}`)).slice(7)}`,
    name: item.name, versionInfo: item.version, downloadLocation: "NOASSERTION", filesAnalyzed: false,
    licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl",
      referenceLocator: `pkg:npm/${item.name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(item.version)}` }],
  }));
  const root = { SPDXID: "SPDXRef-Image", name, versionInfo: image.manifest.digest, downloadLocation: "NOASSERTION",
    filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION" };
  return { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `${name}-${image.platform.architecture}`,
    documentNamespace: `urn:bunko:spdx:${image.manifest.digest}`,
    creationInfo: { creators: [`Tool: bunko-${VERSION}`], created: new Date(timestamp * 1000).toISOString() },
    comment: "Application package inventory from bundled inputs and runtime dependencies. Base OS packages and runtime-loaded undeclared packages are not inventoried. Licenses are not inferred.",
    packages: [root, ...packages], relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: root.SPDXID },
      ...packages.map((p) => ({ spdxElementId: root.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: p.SPDXID })),
    ] };
}

export function provenance(result: BuildResult, lockDigest?: string) {
  const dependency = (uri: string, digest: string) => ({ uri, digest: { sha256: digest.slice(7) } });
  return { _type: "https://in-toto.io/Statement/v1", subject: [{ name: result.target, digest: { sha256: result.root.digest.slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1", predicate: {
      buildDefinition: { buildType: "https://github.com/sakajunquality/bunko/build/v1",
        externalParameters: { platforms: result.images.map((image) => image.platform), mode: result.mode ?? "bundle" },
        internalParameters: {}, resolvedDependencies: [dependency("urn:bunko:source", result.sourceDigest),
          ...(lockDigest ? [dependency("urn:bunko:lock", lockDigest)] : []),
          ...result.images.map((image) => dependency(`urn:bunko:base:${image.platform.architecture}`, image.baseDigest)),
          { uri: `https://github.com/oven-sh/bun/tree/${result.toolchain.revision}`, annotations: { version: result.toolchain.version } },
        ] },
      runDetails: { builder: { id: `https://github.com/sakajunquality/bunko/tree/v${VERSION}` }, metadata: {} },
    } };
}

export async function signImages(references: string[], key: string, executable = "cosign"): Promise<void> {
  for (const reference of [...new Set(references)]) {
    if (!parseReference(reference).reference.startsWith("sha256:")) throw new Error("Signing requires an immutable image@digest");
    // Key-based signatures stay in the selected registry. Never submit to Rekor.
    const child = Bun.spawn([executable, "sign", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false", reference],
      { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await child.exited) throw new Error(`Image signing failed for ${reference}; image publication may already have succeeded`);
  }
}


export async function verifyImage(reference: string, key: string, privateSignatures = false, executable = "cosign"): Promise<void> {
  const ref = parseReference(reference);
  if (!ref.reference.startsWith("sha256:")) throw new Error("Signature verification requires an immutable image@digest");
  const child = Bun.spawn([executable, "verify", "--key", key, ...(privateSignatures ? ["--insecure-ignore-tlog=true"] : []), reference],
    { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if (await child.exited) throw new Error("Image signature verification failed");
}
