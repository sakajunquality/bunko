import { assertFormatVersion } from "../compatibility/formats.ts";
import { canonicalJSON, object, sha256 } from "../oci/digest.ts";
import type { Digest } from "../oci/types.ts";
import type { InventoryEntry } from "./deps.ts";

export const evidencePrefix = "bunko:build-evidence:v1 ";
const evidencePrefixV2 = "bunko:build-evidence:v2 ";
const maxEvidenceBytes = 2 * 1024 * 1024;
export type PackageState = "bundled" | "runtime" | "declared-only";
export interface LockChecksum { algorithm: "SHA256" | "SHA384" | "SHA512"; checksumValue: string }
export interface PackageEvidence { name: string; version: string; states: PackageState[]; lockChecksums: LockChecksum[] }
export interface BuildEvidence { schemaVersion: 1 | 2; scope: "application-inventory"; lockDigest?: Digest; packages: PackageEvidence[]; omitted?: { declaredOnlyPackages: number; lockChecksums: number; includedPackages: number } }
const key = (item: { name: string; version: string }) => `${item.name}@${item.version}`;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Lock hashes identify source archives, not transformed, patched, or installed files. */
function lockChecksum(value: unknown): LockChecksum {
  if (typeof value !== "string") throw new Error("Invalid SBOM lock integrity");
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("Invalid SBOM lock integrity");
  const bytes = Buffer.from(match[2]!, "base64"), size = Number(match[1]!.slice(3)) / 8;
  if (bytes.length !== size || bytes.toString("base64") !== match[2] && bytes.toString("base64").replace(/=+$/, "") !== match[2]) throw new Error("Invalid SBOM lock integrity");
  return { algorithm: match[1]!.toUpperCase() as LockChecksum["algorithm"], checksumValue: bytes.toString("hex") };
}

/** Evidence is deliberately independent of an SPDX or CycloneDX package model. */
export function buildEvidence(image: { inventory: InventoryEntry[]; bundledInventory?: InventoryEntry[] }, lock?: Record<string, unknown>): BuildEvidence {
  const entries = new Map<string, PackageEvidence>();
  const get = (name: string, version: string) => {
    const id = key({ name, version });
    let item = entries.get(id);
    if (!item) { item = { name, version, states: [], lockChecksums: [] }; entries.set(id, item); }
    return item;
  };
  for (const [inventory, state] of [[image.bundledInventory ?? [], "bundled"], [image.inventory, "runtime"]] as const) {
    for (const pkg of inventory) {
      const item = get(pkg.name, pkg.version);
      if (!item.states.includes(state)) item.states.push(state);
    }
  }
  if (lock) for (const record of Object.values(object(lock.packages, "SBOM lock packages"))) {
    // Workspace records have no registry archive integrity.
    if (!Array.isArray(record) || record.length !== 4 || typeof record[0] !== "string") continue;
    const split = record[0].lastIndexOf("@");
    if (split <= 0 || split === record[0].length - 1) throw new Error("Invalid SBOM lock package identity");
    const item = get(record[0].slice(0, split), record[0].slice(split + 1));
    const checksum = lockChecksum(record[3]);
    if (!item.lockChecksums.some((existing) => existing.algorithm === checksum.algorithm && existing.checksumValue === checksum.checksumValue)) item.lockChecksums.push(checksum);
  }
  for (const item of entries.values()) {
    if (!item.states.length) item.states.push("declared-only");
    item.lockChecksums.sort((a, b) => order(`${a.algorithm}:${a.checksumValue}`, `${b.algorithm}:${b.checksumValue}`));
  }
  const evidence: BuildEvidence = { schemaVersion: 1, scope: "application-inventory", ...(lock ? { lockDigest: sha256(canonicalJSON(lock)) } : {}), packages: [...entries.values()].sort((a, b) => order(key(a), key(b))) };
  shrinkEvidence(evidence);
  readEvidence(evidenceComment(evidence), new Set([...image.inventory, ...image.bundledInventory ?? []].map(key)));
  return evidence;
}

/** Drop optional detail deterministically; never fail a valid build due only to evidence volume. */
function shrinkEvidence(evidence: BuildEvidence): void {
  const fits = () => Buffer.byteLength(evidencePrefixV2) + canonicalJSON(evidence).length <= maxEvidenceBytes;
  if (fits()) return;
  evidence.schemaVersion = 2;
  const omitted = evidence.omitted = { declaredOnlyPackages: 0, lockChecksums: 0, includedPackages: 0 };
  evidence.packages = evidence.packages.filter((item) => {
    if (!item.states.includes("declared-only")) return true;
    omitted.declaredOnlyPackages++; omitted.lockChecksums += item.lockChecksums.length; return false;
  });
  if (fits()) return;
  for (const item of evidence.packages) { omitted.lockChecksums += item.lockChecksums.length; item.lockChecksums = []; }
  if (fits()) return;
  omitted.includedPackages = evidence.packages.length; evidence.packages = [];
}

/** Standard SPDX package sourceInfo exposes observations alongside ordinary inventory fields. */
export function packageSourceInfo(item: PackageEvidence | undefined): string {
  if (!item) return "Bunko package build evidence omitted by the document size limit; inclusion detail is unknown.";
  return `Bunko observed package states: ${item.states.join(", ")}. Source archive lock integrity (not installed-file checksums): ${item.lockChecksums.length ? item.lockChecksums.map((hash) => `${hash.algorithm}:${hash.checksumValue}`).join(", ") : "unavailable or omitted"}.`;
}

export function evidenceComment(evidence: BuildEvidence): string {
  const comment = (evidence.schemaVersion === 2 ? evidencePrefixV2 : evidencePrefix) + Buffer.from(canonicalJSON(evidence)).toString();
  if (Buffer.byteLength(comment) > maxEvidenceBytes) throw new Error("SBOM build evidence exceeds 2 MiB");
  return comment;
}

/** Only preserve our bounded, validated evidence during rebase; never copy arbitrary annotations. */
export function readEvidence(comment: string, included: Set<string>): BuildEvidence {
  if (Buffer.byteLength(comment) > maxEvidenceBytes) throw new Error("Unsupported SBOM build evidence");
  const declared = /^bunko:build-evidence:v([0-9]{1,10}) /.exec(comment);
  if (declared) assertFormatVersion("sbom-evidence", Number(declared[1]));
  const prefix = comment.startsWith(evidencePrefixV2) ? evidencePrefixV2 : evidencePrefix;
  if (!comment.startsWith(prefix) || Buffer.byteLength(comment) > maxEvidenceBytes) throw new Error("Unsupported SBOM build evidence");
  const value = object(JSON.parse(comment.slice(prefix.length)), "SBOM build evidence");
  if (value.schemaVersion !== (prefix === evidencePrefixV2 ? 2 : 1) || value.scope !== "application-inventory" || !Array.isArray(value.packages)
      || Object.keys(value).some((name) => !["schemaVersion", "scope", "lockDigest", "packages", ...(value.schemaVersion === 2 ? ["omitted"] : [])].includes(name))
      || value.lockDigest !== undefined && (typeof value.lockDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.lockDigest))) throw new Error("Unsupported SBOM build evidence");
  let missing = 0;
  if (value.schemaVersion === 2) {
    const omitted = object(value.omitted, "SBOM evidence omissions");
    if (Object.keys(omitted).sort().join(",") !== "declaredOnlyPackages,includedPackages,lockChecksums" || Object.values(omitted).some((count) => !Number.isSafeInteger(count) || Number(count) < 0)
        || !Object.values(omitted).some((count) => Number(count) > 0) || (Number(omitted.declaredOnlyPackages) || Number(omitted.lockChecksums)) && value.lockDigest === undefined) throw new Error("Invalid SBOM evidence omissions");
    missing = Number(omitted.includedPackages);
  }
  const seen = new Set<string>();
  for (const entry of value.packages) {
    const item = object(entry, "SBOM package evidence");
    if (typeof item.name !== "string" || !item.name || typeof item.version !== "string" || !Array.isArray(item.states) || !Array.isArray(item.lockChecksums)
        || Object.keys(item).some((name) => !["name", "version", "states", "lockChecksums"].includes(name))) throw new Error("Invalid SBOM package evidence");
    const id = key(item as unknown as PackageEvidence);
    if (seen.has(id) || !item.states.length || new Set(item.states).size !== item.states.length
        || item.states.some((state) => typeof state !== "string" || !["bundled", "runtime", "declared-only"].includes(state))
        || item.states.includes("declared-only") && item.states.length !== 1
        || included.has(id) === item.states.includes("declared-only")
        || item.states.includes("declared-only") && (value.lockDigest === undefined || !item.lockChecksums.length)) throw new Error("Inconsistent SBOM package evidence");
    seen.add(id);
    for (const raw of item.lockChecksums) {
      const checksum = object(raw, "SBOM lock checksum");
      const sizes: Record<string, number> = { SHA256: 64, SHA384: 96, SHA512: 128 };
      if (Object.keys(checksum).length !== 2 || typeof checksum.algorithm !== "string" || !Object.hasOwn(sizes, checksum.algorithm)
          || typeof checksum.checksumValue !== "string" || checksum.checksumValue.length !== sizes[checksum.algorithm] || !/^[a-f0-9]+$/.test(checksum.checksumValue)
          || value.lockDigest === undefined) throw new Error("Invalid SBOM lock checksum");
    }
  }
  if ([...included].filter((id) => !seen.has(id)).length !== missing) throw new Error("Incomplete SBOM package evidence");
  return value as unknown as BuildEvidence;
}
