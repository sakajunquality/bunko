import { evidenceComment, readEvidence } from "./sbom-evidence.ts";
import { canonicalJSON, sha256 } from "../oci/digest.ts";
import type { Descriptor, Digest, Platform } from "../oci/types.ts";
import { VERSION } from "./config.ts";
import { packageLicense } from "./inventory.ts";

const SPDX_ID = "SPDXRef-DOCUMENT";
const ROOT_ID = "SPDXRef-Image";

function record(value: unknown, context: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, any>;
}

function digest(value: unknown, context: string): asserts value is Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${context} must be a sha256 digest`);
}

function descriptor(value: unknown, context: string): Descriptor {
  const d = record(value, context);
  digest(d.digest, `${context}.digest`);
  if (typeof d.mediaType !== "string" || !Number.isSafeInteger(d.size) || d.size < 0) throw new Error(`${context} is not a descriptor`);
  return d as Descriptor;
}

function sourceObject(input: unknown): Record<string, any> {
  if (input instanceof Uint8Array) {
    try { return record(JSON.parse(Buffer.from(input).toString()), "SPDX input"); }
    catch { throw new Error("SPDX input must be valid JSON"); }
  }
  if (typeof input === "string") {
    try { return record(JSON.parse(input), "SPDX input"); }
    catch { throw new Error("SPDX input must be valid JSON"); }
  }
  return record(input, "SPDX input");
}

function cleanPackage(value: Record<string, any>, id: string): Record<string, any> {
  if (typeof value.name !== "string" || typeof value.versionInfo !== "string") throw new Error(`Invalid SPDX package ${id}`);
  const result: Record<string, any> = {
    SPDXID: id, name: value.name, versionInfo: value.versionInfo, downloadLocation: "NOASSERTION",
    filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: packageLicense(value.licenseDeclared) ?? "NOASSERTION",
    copyrightText: "NOASSERTION",
  };
  const purl = Array.isArray(value.externalRefs) ? value.externalRefs.find((ref: any) => ref?.referenceType === "purl" && typeof ref.referenceLocator === "string") : undefined;
  if (purl) result.externalRefs = [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: purl.referenceLocator }];
  return result;
}

export function rebaseSpdx(input: unknown, original: Descriptor, output: Descriptor, platform: Platform, epoch: number,
  baseInventory?: { namespace: string; digest: Digest; described: string[] }, expectedRuntime: { kind: "bun" | "node"; version?: string } = { kind: "bun" }): unknown {
  const value = sourceObject(input);
  descriptor(original, "original"); descriptor(output, "output");
  if (value.spdxVersion !== "SPDX-2.3" || value.SPDXID !== SPDX_ID || typeof value.documentNamespace !== "string" || !Array.isArray(value.packages)) throw new Error("Unsupported Bunko SPDX-2.3 document");
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid attestation epoch");
  if (!record(value.creationInfo, "SPDX creationInfo").creators || !Array.isArray(value.creationInfo.creators) || !value.creationInfo.creators.some((creator: unknown) => typeof creator === "string" && /^Tool: bunko-/.test(creator))) throw new Error("SPDX creator is not a Bunko tool");
  if (value.dataLicense !== "CC0-1.0") throw new Error("Unsupported SPDX data license");
  const packages = value.packages.map((item: unknown) => record(item, "SPDX package"));
  const allPackageIds = packages.map((item) => item.SPDXID);
  if (allPackageIds.some((id) => typeof id !== "string") || new Set(allPackageIds).size !== allPackageIds.length) throw new Error("Duplicate or invalid SPDX package ID");
  const root = packages.find((item) => item.SPDXID === ROOT_ID);
  if (!root || root.versionInfo !== original.digest) throw new Error("Original SPDX subject mismatch");
  if (packages.filter((item) => item.SPDXID === ROOT_ID).length !== 1) throw new Error("SPDX document must contain exactly one image root");
  if (typeof root.name !== "string") throw new Error("Original SPDX root package is invalid");
  for (const item of packages) if (item.SPDXID !== ROOT_ID && item.SPDXID !== "SPDXRef-Bun-Runtime" && item.SPDXID !== "SPDXRef-Node-Runtime" && !(typeof item.SPDXID === "string" && /^SPDXRef-Package-[A-Za-z0-9._-]+$/.test(item.SPDXID))) throw new Error(`Unknown SPDX package ID ${String(item.SPDXID)}`);
  const preserved = packages.filter((item) => typeof item.SPDXID === "string" && /^SPDXRef-Package-[A-Za-z0-9._-]+$/.test(item.SPDXID));
  const runtimes = packages.filter((item) => ["SPDXRef-Bun-Runtime", "SPDXRef-Node-Runtime"].includes(item.SPDXID));
  if (runtimes.length > 1) throw new Error("Conflicting runtime inventories");
  const runtime = runtimes[0], nodeRuntime = runtime?.SPDXID === "SPDXRef-Node-Runtime";
  if (Boolean(nodeRuntime) !== (expectedRuntime.kind === "node") || nodeRuntime && runtime.versionInfo !== expectedRuntime.version) throw new Error("Runtime inventory differs from the image metadata");
  if (nodeRuntime && (runtime.name !== "node" || !["22", "24"].includes(runtime.versionInfo))) throw new Error("Invalid Node runtime inventory");
  if (runtime && !nodeRuntime && (runtime.name !== "bun" || typeof runtime.versionInfo !== "string" || !runtime.versionInfo || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(runtime.versionInfo))) throw new Error("Invalid Bun runtime inventory");
  for (const item of preserved) {
    const expectedId = `SPDXRef-Package-${sha256(`${item.name}@${item.versionInfo}`).slice(7)}`;
    if (item.SPDXID !== expectedId) throw new Error(`Invalid package inventory ID ${item.SPDXID}`);
    const expectedPurl = `pkg:npm/${String(item.name).split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(item.versionInfo)}`;
    const refs = Array.isArray(item.externalRefs) ? item.externalRefs.filter((ref: any) => ref?.referenceType === "purl") : [];
    if (refs.length !== 1 || refs[0].referenceLocator !== expectedPurl) throw new Error(`Invalid npm package purl ${item.SPDXID}`);
  }
  let file: Record<string, any> | undefined;
  const relationships = Array.isArray(value.relationships) ? value.relationships.map((item: unknown) => record(item, "SPDX relationship")) : [];
  if (!relationships.some((rel) => rel.spdxElementId === SPDX_ID && rel.relationshipType === "DESCRIBES" && rel.relatedSpdxElement === ROOT_ID)) throw new Error("SPDX document must describe its image root");
  const runtimeRelationships = runtime ? relationships.filter((rel) => rel.spdxElementId === ROOT_ID && rel.relatedSpdxElement === runtime.SPDXID) : [];
  if (runtime && runtimeRelationships.length !== 1 || !runtime && runtimeRelationships.length) throw new Error("Inconsistent Bun runtime relationship");
  const runtimeRelationshipType = runtimeRelationships[0]?.relationshipType;
  if (runtime && runtimeRelationshipType !== "CONTAINS" && runtimeRelationshipType !== "DEPENDS_ON") throw new Error("Unsupported Bun runtime relationship");
  if (value.files !== undefined && !Array.isArray(value.files)) throw new Error("SPDX files must be an array");
  if (Array.isArray(value.files)) {
    if (value.files.some((item: unknown) => !record(item, "SPDX file").SPDXID || record(item, "SPDX file").SPDXID !== "SPDXRef-Bun-Executable")) throw new Error("Unknown SPDX file ID");
    if (value.files.filter((item: any) => item?.SPDXID === "SPDXRef-Bun-Executable").length > 1) throw new Error("Duplicate Bun executable inventory");
    const candidate = value.files.find((item: any) => item?.SPDXID === "SPDXRef-Bun-Executable");
    if (candidate) {
      if (!runtime || nodeRuntime || typeof candidate.fileName !== "string" || !candidate.fileName.startsWith("/") || candidate.fileName.split("/").includes("..") || !Array.isArray(candidate.checksums) || candidate.checksums.length !== 1 || candidate.checksums[0]?.algorithm !== "SHA256" || typeof candidate.checksums[0]?.checksumValue !== "string" || !/^[a-f0-9]{64}$/.test(candidate.checksums[0].checksumValue)) throw new Error("Invalid Bun executable inventory");
      file = { SPDXID: "SPDXRef-Bun-Executable", fileName: candidate.fileName, fileTypes: ["BINARY"], checksums: [{ algorithm: "SHA256", checksumValue: candidate.checksums[0].checksumValue }], licenseConcluded: "NOASSERTION", licenseInfoInFiles: ["NOASSERTION"], copyrightText: "NOASSERTION" };
    }
  }
  if (baseInventory) {
    if (typeof baseInventory.namespace !== "string" || !baseInventory.namespace || !URL.canParse(baseInventory.namespace)) throw new Error("Invalid base inventory namespace");
    digest(baseInventory.digest, "base inventory digest");
    if (!Array.isArray(baseInventory.described) || baseInventory.described.some((id) => typeof id !== "string" || !/^SPDXRef-[A-Za-z0-9._-]+$/.test(id)) || new Set(baseInventory.described).size !== baseInventory.described.length) throw new Error("Invalid base inventory described IDs");
  }
  if (value.annotations !== undefined && !Array.isArray(value.annotations)) throw new Error("SPDX annotations must be an array");
  const annotations = (value.annotations ?? []).filter((item: any) => typeof item?.comment === "string" && item.comment.startsWith("bunko:build-evidence:"));
  if (annotations.length > 1) throw new Error("Duplicate SBOM build evidence");
  const evidence = annotations.length ? readEvidence(annotations[0].comment, new Set(preserved.map((item) => `${item.name}@${item.versionInfo}`))) : undefined;
  const cleanRoot = { SPDXID: ROOT_ID, name: root.name, versionInfo: output.digest, downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION" };
  const cleanPackages = preserved.map((item) => cleanPackage(item, item.SPDXID)).sort((a, b) => a.SPDXID.localeCompare(b.SPDXID));
  const cleanRuntime = runtime ? cleanPackage(runtime, runtime.SPDXID) : undefined;
  if (cleanRuntime) cleanRuntime.externalRefs = [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:generic/${nodeRuntime ? "node" : "bun"}@${encodeURIComponent(runtime!.versionInfo)}` }];
  if (cleanRuntime && nodeRuntime) cleanRuntime.comment = "Declared Node major preserved from the original SBOM; no runtime version verification was performed";
  const document: Record<string, any> = {
    spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: SPDX_ID, name: `${root.name}-${platform.architecture}`,
    creationInfo: { creators: [`Tool: bunko-${VERSION}`], created: new Date(epoch * 1000).toISOString().replace(".000Z", "Z") },
    ...(evidence ? { annotations: [{ annotationType: "OTHER", annotator: `Tool: bunko-${VERSION}`, annotationDate: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"), comment: evidenceComment(evidence) }] } : {}),
    comment: "Application package inventories preserved from the original SBOM; no source build or rescan was performed. Base OS packages are represented only by an explicitly linked external document.",
    ...(baseInventory ? { externalDocumentRefs: [{ externalDocumentId: "DocumentRef-Base", spdxDocument: baseInventory.namespace, checksum: { algorithm: "SHA256", checksumValue: baseInventory.digest.slice(7) } }] } : {}),
    ...(file ? { files: [file] } : {}), packages: [cleanRoot, ...cleanPackages, ...(cleanRuntime ? [cleanRuntime] : [])],
    relationships: [
      { spdxElementId: SPDX_ID, relationshipType: "DESCRIBES", relatedSpdxElement: ROOT_ID },
      ...cleanPackages.map((item) => ({ spdxElementId: ROOT_ID, relationshipType: "CONTAINS", relatedSpdxElement: item.SPDXID })),
      ...(cleanRuntime ? [{ spdxElementId: ROOT_ID, relationshipType: runtimeRelationshipType, relatedSpdxElement: cleanRuntime.SPDXID }] : []),
      ...(file ? [{ spdxElementId: ROOT_ID, relationshipType: "CONTAINS", relatedSpdxElement: file.SPDXID }, ...(cleanRuntime ? [{ spdxElementId: file.SPDXID, relationshipType: "GENERATED_FROM", relatedSpdxElement: cleanRuntime.SPDXID }] : [])] : []),
      ...(baseInventory ? baseInventory.described.map((id) => ({ spdxElementId: ROOT_ID, relationshipType: "CONTAINS", relatedSpdxElement: `DocumentRef-Base:${id}` })) : []),
    ],
  };
  return { ...document, documentNamespace: `urn:bunko:spdx:rebase:${sha256(canonicalJSON(document))}` };
}

export function rebaseProvenance(input: { source: Descriptor; root: Descriptor; platforms: { platform: Platform; oldBase: Digest; newBase: Digest; preservedLayers: Digest[]; policy: string }[]; builder: { kind: string; digest: Digest }; policyDigest?: Digest; inventoryDigests?: Digest[] }): unknown {
  descriptor(input.source, "source"); descriptor(input.root, "root"); digest(input.builder.digest, "builder.digest");
  const dependency = (uri: string, d: Digest) => ({ uri, digest: { sha256: d.slice(7) } });
  const materials = [dependency("urn:bunko:rebase:original-image", input.source.digest), ...input.platforms.flatMap((item) => {
    digest(item.oldBase, "old base"); digest(item.newBase, "new base");
    if (typeof item.policy !== "string") throw new Error("Rebase policy must be a string");
    const policy = input.policyDigest ?? sha256(item.policy);
    return [dependency(`urn:bunko:rebase:old-base:${item.platform.os}/${item.platform.architecture}`, item.oldBase), dependency(`urn:bunko:rebase:new-base:${item.platform.os}/${item.platform.architecture}`, item.newBase), dependency("urn:bunko:rebase:policy", policy), ...item.preservedLayers.map((d, i) => { digest(d, "preserved layer"); return dependency(`urn:bunko:rebase:preserved-layer:${item.platform.architecture}:${i}`, d); })];
  }), ...(input.inventoryDigests ?? []).map((d, i) => { digest(d, "inventory digest"); return dependency(`urn:bunko:rebase:inventory:${i}`, d); })];
  return { _type: "https://in-toto.io/Statement/v1", subject: [{ name: "bunko-rebase", digest: { sha256: input.root.digest.slice(7) } }], predicateType: "https://slsa.dev/provenance/v1", predicate: { buildDefinition: { buildType: "https://github.com/sakajunquality/bunko/rebase/v1", externalParameters: { platforms: input.platforms.map(({ platform }) => platform), tool: `bunko-${VERSION}` }, internalParameters: { builder: input.builder }, resolvedDependencies: materials }, runDetails: { builder: { id: `https://github.com/sakajunquality/bunko`, builderDependencies: [dependency(`urn:bunko:builder:${input.builder.kind}`, input.builder.digest)] }, metadata: {} } } };
}
