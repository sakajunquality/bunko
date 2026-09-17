import { expect, test } from "bun:test";
import { buildEvidence, evidenceComment, evidencePrefix, readEvidence } from "../packages/bunko/sbom-evidence.ts";
import { spdx } from "../packages/bunko/attest.ts";
import { rebaseSpdx } from "../packages/bunko/rebase-attest.ts";
import type { PlatformResult } from "../packages/bunko/build.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";

const pkg = (name: string) => ({ name, version: "1.0.0", path: `node_modules/${name}` });
const record = (name: string, byte = 1) => [`${name}@1.0.0`, "https://private.invalid/archive.tgz", {}, `sha512-${Buffer.alloc(64, byte).toString("base64")}`];
const lock = { packages: { both: record("both"), alias: record("both", 2), unused: record("unused"), workspace: ["local@workspace:packages/local"] } };
const image = { inventory: [pkg("both"), pkg("runtime")], bundledInventory: [pkg("both"), pkg("bundled")] };

test("build evidence retains overlapping states and source archive checksums without private paths or URLs", () => {
  const evidence = buildEvidence(image, lock);
  expect(evidence.packages.map((p) => [p.name, p.states])).toEqual([
    ["both", ["bundled", "runtime"]], ["bundled", ["bundled"]], ["runtime", ["runtime"]], ["unused", ["declared-only"]],
  ]);
  expect(evidence.packages[0]!.lockChecksums).toEqual([1, 2].map((byte) => ({ algorithm: "SHA512", checksumValue: Buffer.alloc(64, byte).toString("hex") })));
  expect(evidence.lockDigest).toBe(sha256(canonicalJSON(lock)));
  expect(evidenceComment(evidence)).not.toContain("private.invalid");
  expect(evidenceComment(evidence)).not.toContain("node_modules");
  expect(evidenceComment(evidence)).not.toContain("packages/local");
  const reordered = { packages: Object.fromEntries(Object.entries(lock.packages).reverse()) };
  expect(buildEvidence({ inventory: [...image.inventory].reverse(), bundledInventory: [...image.bundledInventory].reverse() }, reordered)).toEqual(evidence);
  expect(readEvidence(evidenceComment(evidence), new Set(["both@1.0.0", "runtime@1.0.0", "bundled@1.0.0"]))).toEqual(evidence);
});

test("missing lock evidence is unknown and malformed integrity is rejected", () => {
  expect(buildEvidence(image).lockDigest).toBeUndefined();
  expect(buildEvidence(image).packages.every((p) => p.lockChecksums.length === 0)).toBe(true);
  for (const integrity of ["sha512-YQ==", "sha512-!", "md5-YQ=="]) {
    expect(() => buildEvidence(image, { packages: { both: ["both@1.0.0", "", {}, integrity] } })).toThrow("lock integrity");
  }
  for (const algorithm of ["sha256", "sha384", "sha512"]) {
    const bytes = Buffer.alloc(Number(algorithm.slice(3)) / 8, 3);
    expect(buildEvidence(image, { packages: { both: ["both@1.0.0", "", {}, `${algorithm}-${bytes.toString("base64")}`] } }).packages[0]!.lockChecksums[0]!.checksumValue).toBe(bytes.toString("hex"));
  }
});

test("evidence is bounded and rejects inconsistent identities or unknown extensions on rebase", () => {
  const evidence = buildEvidence(image, lock), included = new Set(["both@1.0.0", "runtime@1.0.0", "bundled@1.0.0"]);
  const read = (value: unknown) => readEvidence(evidencePrefix + JSON.stringify(value), included);
  expect(() => read({ ...evidence, schemaVersion: 2 })).toThrow();
  expect(() => read({ ...evidence, packages: evidence.packages.map((p) => ({ ...p, states: [["bundled"]] })) })).toThrow();
  expect(() => read({ ...evidence, secret: "private" })).toThrow();
  expect(() => read({ ...evidence, packages: evidence.packages.slice(1) })).toThrow();
  expect(() => read({ ...evidence, packages: [...evidence.packages, evidence.packages[0]] })).toThrow();
  expect(() => read({ ...evidence, packages: evidence.packages.map((p) => p.name === "both" ? { ...p, states: ["declared-only"] } : p) })).toThrow();
  expect(() => readEvidence(evidencePrefix + " ".repeat(2 * 1024 * 1024), included)).toThrow();
});

test("SPDX and rebase retain evidence without asserting archive hashes for transformed packages", () => {
  const descriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256("original"), size: 123 };
  const platform = { os: "linux", architecture: "amd64" } as const;
  const input = { ...image, platform, manifest: descriptor } as PlatformResult;
  const evidence = buildEvidence(image, lock);
  const document = spdx("example", input, 0, undefined, evidence);
  expect(document.packages.some((p) => p.name === "unused")).toBe(false);
  expect(document.packages.every((p) => !("checksums" in p))).toBe(true);
  expect(document.packages.every((p) => !p.filesAnalyzed)).toBe(true);
  expect(spdx("example", input, 0).annotations).toBeUndefined();
  const output = { ...descriptor, digest: sha256("rebased") };
  const rebased = rebaseSpdx(document, descriptor, output, platform, 1) as typeof document;
  expect(rebased.annotations![0]!.comment).toBe(document.annotations![0]!.comment);
  expect(rebased.annotations![0]!.annotationDate).not.toBe(document.annotations![0]!.annotationDate);
  expect(rebased.packages[0]!.versionInfo).toBe(output.digest);
  expect(rebased.documentNamespace).not.toBe(document.documentNamespace);
  expect(() => rebaseSpdx({ ...document, annotations: [document.annotations![0], document.annotations![0]] }, descriptor, output, platform, 1)).toThrow("Duplicate");
});

test("evidence option is accepted only by build-producing commands", async () => {
  const { validateCommandOptions } = await import("../packages/bunko/command-options.ts");
  for (const command of ["build", "resolve", "apply"]) expect(() => validateCommandOptions(command, ["sbom", "sbom-evidence"])).not.toThrow();
  for (const command of ["rebase", "metadata", "doctor"]) expect(() => validateCommandOptions(command, ["sbom-evidence"])).toThrow("not supported");
});

test("supply-chain policy validates evidence even before resolving build references", async () => {
  const { supplyChainOptions } = await import("../packages/bunko/policy.ts");
  expect(() => supplyChainOptions({ sbomEvidence: true })).toThrow("requires --sbom");
  expect(supplyChainOptions({ sbom: true, sbomEvidence: true }).sbomEvidence).toBe(true);
  expect(supplyChainOptions({ sbomEvidence: true, supplyChainPolicy: "ci", reproducible: true, signKey: "fixture" })).toMatchObject({ sbom: true });
});

test("large evidence degrades in stages with explicit omissions and rebase validation", () => {
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const hugeLock = { packages: Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`p${i}`, [`p${i}@1.0.0`, "", {}, integrity]])) };
  const first = buildEvidence({ inventory: [{ name: "p0", version: "1.0.0", path: "node_modules/p0" }] }, hugeLock);
  expect(first.schemaVersion).toBe(2); expect(first.omitted?.declaredOnlyPackages).toBe(8999);
  expect(first.packages).toHaveLength(1); expect(first.packages[0]!.lockChecksums).toHaveLength(1);
  const inventory = Array.from({ length: 9000 }, (_, i) => ({ name: `p${i}`, version: "1.0.0", path: `node_modules/p${i}` }));
  const second = buildEvidence({ inventory }, hugeLock);
  expect(second.omitted?.lockChecksums).toBe(9000); expect(second.packages).toHaveLength(9000);
  const huge = Array.from({ length: 24000 }, (_, i) => ({ name: `long-package-name-${i}`, version: "1.0.0", path: `node_modules/p${i}` }));
  const third = buildEvidence({ inventory: huge });
  expect(third.packages).toHaveLength(0); expect(third.omitted?.includedPackages).toBe(24000);
  for (const [evidence, values] of [[first, inventory.slice(0, 1)], [second, inventory], [third, huge]] as const) {
    const comment = evidenceComment(evidence); expect(Buffer.byteLength(comment)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(readEvidence(comment, new Set(values.map((item) => `${item.name}@${item.version}`)))).toEqual(evidence);
  }
  const invalid = structuredClone(third); invalid.omitted!.includedPackages--;
  expect(() => readEvidence(evidenceComment(invalid), new Set(huge.map((item) => `${item.name}@${item.version}`)))).toThrow("Incomplete");
});

test("package sourceInfo exposes inclusion evidence and survives rebase without false checksums", () => {
  const descriptor = { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256("input"), size: 123 };
  const platform = { os: "linux", architecture: "amd64" } as const;
  const document = spdx("example", { ...image, platform, manifest: descriptor } as PlatformResult, 0, undefined, buildEvidence(image, lock));
  const pkg = document.packages.find((item) => item.name === "both")!;
  expect((pkg as any).sourceInfo).toContain("bundled, runtime"); expect((pkg as any).sourceInfo).toContain("not installed-file checksums");
  const rebased = rebaseSpdx(document, descriptor, { ...descriptor, digest: sha256("output") }, platform, 1) as typeof document;
  expect((rebased.packages.find((item) => item.name === "both") as any).sourceInfo).toBe((pkg as any).sourceInfo);
});
