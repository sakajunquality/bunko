import { packageLicense } from "./inventory.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../oci/digest.ts";
import type { BuildResult, PlatformResult } from "./build.ts";
import type { InventoryEntry } from "./deps.ts";
import { parseReference } from "../oci/source.ts";
import { VERSION } from "./config.ts";

export const sbomType = "application/spdx+json";
export const provenanceType = "application/vnd.in-toto+json";

export function spdx(name: string, image: PlatformResult, timestamp: number, runtime?: { version: string; revision: string; embedded: boolean }) {
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
  return { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `${name}-${image.platform.architecture}`,
    documentNamespace: `urn:bunko:spdx:${image.manifest.digest}`,
    creationInfo: { creators: [`Tool: bunko-${VERSION}`], created: new Date(timestamp * 1000).toISOString().replace(".000Z", "Z") },
    comment: "Application package inventory from bundled inputs and runtime dependencies. Base OS packages are represented only by an explicitly linked external document, when supplied. Undeclared runtime-loaded packages are not inventoried. Unknown license declarations are not inferred.",
    ...(image.baseInventory ? { externalDocumentRefs: [{ externalDocumentId: "DocumentRef-Base", spdxDocument: image.baseInventory.namespace, checksum: { algorithm: "SHA256", checksumValue: image.baseInventory.digest.slice(7) } }] } : {}),
    packages: [root, ...packages, ...(runtime ? [{ SPDXID: "SPDXRef-Bun-Runtime", name: "bun", versionInfo: runtime.version, downloadLocation: image.runtime?.url ?? "NOASSERTION", ...(image.runtime ? { checksums: [{ algorithm: "SHA256", checksumValue: image.runtime.executableDigest.slice(7) }] } : {}), filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION", comment: image.runtime ? `Injected signed release; policy ${image.runtime.policy}; signer ${image.runtime.signer}; release revision ${image.runtime.releaseRevision}; runtime execution not verified` : `${runtime.embedded ? "Embedded" : "Expected base"} Bun runtime revision ${runtime.revision}; custom base runtime identity is not independently verified`, externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:generic/bun@${runtime.version}` }] }] : [])], relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: root.SPDXID },
      ...(runtime ? [{ spdxElementId: root.SPDXID, relationshipType: runtime.embedded || image.runtime ? "CONTAINS" : "DEPENDS_ON", relatedSpdxElement: "SPDXRef-Bun-Runtime" }] : []),
      ...(image.baseInventory?.described.map((id) => ({ spdxElementId: root.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: `DocumentRef-Base:${id}` })) ?? []),
      ...packages.map((p) => ({ spdxElementId: root.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: p.SPDXID })),
    ] };
}

export function provenance(result: BuildResult, lockDigest?: string) {
  const dependency = (uri: string, digest: string) => ({ uri, digest: { sha256: digest.slice(7) } });
  return { _type: "https://in-toto.io/Statement/v1", subject: [{ name: result.target, digest: { sha256: result.root.digest.slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1", predicate: {
      buildDefinition: { buildType: "https://github.com/sakajunquality/bunko/build/v1",
        externalParameters: { platforms: result.images.map((image) => image.platform), mode: result.mode ?? "bundle", ...(result.assetMaterials ? { assetMappings: result.assetMaterials.map(({ digest, ...mapping }) => mapping) } : {}) },
        internalParameters: { builder: result.builder }, resolvedDependencies: [dependency("urn:bunko:source", result.sourceDigest),
          ...(result.assetMaterials ?? []).map((material, index) => dependency(`urn:bunko:asset:${material.context}:${index}`, material.digest)),
          ...(lockDigest ? [dependency("urn:bunko:lock", lockDigest)] : []),
          ...result.images.flatMap((image) => image.runtime ? [dependency(image.runtime.url, image.runtime.archiveDigest)] : []),
          ...result.images.map((image) => dependency(`urn:bunko:base:${image.platform.architecture}`, image.baseDigest)),
          ...result.images.flatMap((image) => image.baseInventory ? [dependency(`oci://${image.baseInventory.reference}`, image.baseInventory.artifactDigest)] : []),
          ...result.images.flatMap((image) => image.dependencyArtifact ? [dependency(`urn:bunko:dependencies:${image.platform.architecture}`, image.dependencyArtifact)] : []),
          { uri: `https://github.com/oven-sh/bun/tree/${result.toolchain.revision}`, ...(result.toolchain.digest ? { digest: { sha256: result.toolchain.digest.slice(7) } } : {}), annotations: { version: result.toolchain.version } },
        ] },
      runDetails: { builder: { id: `https://github.com/sakajunquality/bunko`, ...(result.builder ? { builderDependencies: [{ uri: `urn:bunko:builder:${result.builder.kind}`, digest: { sha256: result.builder.digest.slice(7) } }] } : {}) }, metadata: {} },
    } };
}

/** Keep cloud credential-helper configuration, but never inherit cosign's
 * destination or public-service overrides. Raw helper output may contain secrets. */
export function signingEnvironment(): Record<string, string> {
  const env: Record<string, string> = { HOME: homedir(), PATH: process.env.PATH ?? "" };
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined &&
    (/^(AWS_|GOOGLE_|CLOUDSDK_|AZURE_|ARM_|VAULT_|DOCKER_)/.test(key) || ["HOME", "PATH", "COSIGN_PASSWORD", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"].includes(key))) env[key] = value;
  return env;
}

async function cosignCommand(executable: string, args: string[]): Promise<void> {
  const env = signingEnvironment();
  let directory: string | undefined;
  try {
    if (process.env.BUNKO_DOCKER_CONFIG) {
      directory = await mkdtemp(join(tmpdir(), "bunko-sign-auth-"));
      await writeFile(join(directory, "config.json"), await readFile(process.env.BUNKO_DOCKER_CONFIG), { mode: 0o600, flag: "wx" });
      env.DOCKER_CONFIG = directory;
    }
    const child = Bun.spawn([executable, ...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 120_000);
    try {
      const code = await child.exited;
      if (code) throw new Error(`cosign ${args[0]} failed (exit ${code}); check key password, registry credentials and cosign v3.1.3 compatibility`);
    } finally { clearTimeout(timer); }
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

export async function signImages(references: string[], key: string, executable = "cosign", insecure: string[] = []): Promise<void> {
  for (const reference of [...new Set(references)]) {
    const ref = parseReference(reference);
    if (!ref.reference.startsWith("sha256:")) throw new Error("Signing requires an immutable image@digest");
    // Key-based signatures stay in the selected registry. Never submit to Rekor.
    await cosignCommand(executable, ["sign", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false",
      ...(insecure.includes(ref.registry) ? ["--allow-http-registry"] : []), reference]);
  }
}

export async function verifyImage(reference: string, key: string, privateSignatures = false, executable = "cosign", insecure: string[] = []): Promise<void> {
  const ref = parseReference(reference);
  if (!ref.reference.startsWith("sha256:")) throw new Error("Signature verification requires an immutable image@digest");
  await cosignCommand(executable, ["verify", "--key", key, ...(privateSignatures ? ["--insecure-ignore-tlog=true"] : []),
    ...(insecure.includes(ref.registry) ? ["--allow-http-registry"] : []), reference]);
}
