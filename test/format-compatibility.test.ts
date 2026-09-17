import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertReportWritable } from "../packages/bunko/build.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertFormatVersion, UnsupportedFormatError } from "../packages/compatibility/formats.ts";
import { inspectRebase } from "../packages/oci/rebase.ts";
import { readEvidence } from "../packages/bunko/sbom-evidence.ts";

const fixtures = join(import.meta.dir, "fixtures/compat");
for (const version of ["0.8.0", "0.9.0", "0.10.0", "0.11.0"]) {
  test(`reads ownership metadata emitted by released ${version} writer`, async () => {
    const { base, image } = await Bun.file(join(fixtures, version, "rebase.json")).json();
    const result = inspectRebase(image, base);
    expect(result.context.mode).toBe("bundle");
    expect(result.options.env).toEqual({ APP: "value" });
    expect(result.layers.map((layer) => layer.kind)).toEqual(["app"]);
    expect(result.options.user).toBeUndefined();
  });
  if (version !== "0.8.0") {
    test(`reads Node ownership and evidence emitted by released ${version} writer`, async () => {
      const { base, image } = await Bun.file(join(fixtures, version, "rebase-node.json")).json();
      expect(inspectRebase(image, base).context.runtimeKind).toBe("node");
      const fixture = await Bun.file(join(fixtures, version, "evidence.json")).json();
      const evidence = readEvidence(fixture.comment, new Set(fixture.included));
      expect(evidence.schemaVersion).toBe(1);
      expect(evidence.packages.map((pkg) => pkg.states)).toEqual([["bundled"], ["declared-only"], ["runtime"]]);
      expect(evidence.packages[1]!.lockChecksums[0]!.algorithm).toBe("SHA512");
    });
  }
}

test("reads degraded evidence from the released 0.11.0 writer without claiming omitted absence", async () => {
  const fixture = await Bun.file(join(fixtures, "0.11.0/evidence-degraded.json")).json();
  const evidence = readEvidence(fixture.comment, new Set(fixture.included));
  expect(evidence.schemaVersion).toBe(2);
  expect(evidence.omitted!.declaredOnlyPackages).toBe(20_000);
  expect(evidence.packages).toHaveLength(2);
});

test("newer versions have typed diagnostics before closed-world field validation", async () => {
  const { base, image } = await Bun.file(join(fixtures, "0.11.0/rebase.json")).json();
  const key = "org.bunko.rebase.metadata", capsule = JSON.parse(image.config.config.Labels[key]);
  image.config.config.Labels[key] = JSON.stringify({ ...capsule, version: 2, future: true });
  expect(() => inspectRebase(image, base)).toThrow(UnsupportedFormatError);
  expect(() => inspectRebase(image, base)).toThrow("newer than this Bunko reader");
  expect(() => readEvidence("bunko:build-evidence:v3 {}", new Set())).toThrow(UnsupportedFormatError);
  for (const value of [null, "2", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => assertFormatVersion("rebase-capsule", value)).toThrow("Invalid");
  image.config.config.Labels[key] = JSON.stringify({ ...capsule, future: true });
  expect(() => inspectRebase(image, base)).toThrow("unknown capsule field");
});


test("released evidence reader matrix records the supported rollback boundary", async () => {
  const matrix = await Bun.file(join(fixtures, "evidence-readers.json")).json();
  expect(matrix).toHaveLength(12);
  for (const row of matrix) expect(row.accepted).toBe(row.fixture !== "evidence-degraded.json" || row.reader === "0.11.0");
});


test("future report versions are diagnosed without overwriting their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-report-format-"));
  try {
    const file = join(root, "report.json"), content = JSON.stringify({ schemaVersion: 99, command: "rebase", status: "success" });
    await writeFile(file, content);
    await expect(assertReportWritable(file)).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(await readFile(file, "utf8")).toBe(content);
    for (const report of [
      { schemaVersion: 99, target: "app", images: [], root: { digest: `sha256:${"a".repeat(64)}` } },
      { schemaVersion: 99, status: "success", targets: [] },
      { schemaVersion: 99, command: "push-layout", status: "success" },
    ]) {
      const text = JSON.stringify(report); await writeFile(file, text);
      await expect(assertReportWritable(file)).rejects.toBeInstanceOf(UnsupportedFormatError);
      expect(await readFile(file, "utf8")).toBe(text);
    }
    await writeFile(file, JSON.stringify({ schemaVersion: 1, command: "base-status", results: [] }));
    await expect(assertReportWritable(file)).resolves.toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
