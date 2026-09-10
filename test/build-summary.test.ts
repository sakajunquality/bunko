import { expect, test } from "bun:test";
import { renderSummary, summaryBytes, summaryNote } from "../build/summary.ts";

const digest = `sha256:${"b".repeat(64)}`;
const layer = (kind: string, size: number) => ({ kind, descriptor: { size, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" }, diffId: `sha256:${kind.padEnd(64, "0")}` });
const timing = (phase: string, durationMs: number, platform?: string, status = "completed") => ({ phase, status, durationMs, ...platform ? { platform } : {} });

function singleTarget(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2, target: "services/api", platform: "linux/amd64", builder: { version: "9.9.9", digest, kind: "bundle" },
    timings: [timing("install", 12_400.4, "linux/amd64"), timing("bundle", 3100, "linux/amd64"), timing("pack", 2050, "linux/amd64"), timing("pack", 900, "linux/amd64"), timing("snapshot", 640), timing("publish", 99_000, undefined, "failed")],
    cache: [{ kind: "deps", key: digest, status: "local" }, { kind: "assets", key: digest, status: "registry", source: "registry.example/cache" }, { kind: "app", key: digest, status: "miss", reason: "not-found" }],
    layers: [layer("deps", 13_800_000), layer("assets", 10_900_000), layer("app", 120_000)],
    images: [{ platform: { os: "linux", architecture: "amd64" }, layers: [layer("deps", 13_800_000)] }],
    publication: { reference: `ghcr.io/team/api@${digest}`, published: true, tags: ["main"], pendingTags: [], blobs: { reused: 12, mounted: 3, uploaded: 5, wouldUpload: 0 }, transfers: [{ digest, kind: "layer", size: 8_200_000, uploaded: 8_200_000, action: "uploaded" }], elapsedMs: 4120.7 },
    ...extra,
  };
}

test("summary reports version, per-phase totals, cache, layers and publication for one platform", () => {
  const summary = renderSummary(singleTarget());
  expect(summary.startsWith("### bunko build\n")).toBe(true);
  expect(summary).toContain("bunko 9.9.9");
  expect(summary).toContain("bunko 9.9.9 — services/api (linux/amd64)");
  expect(summary).toContain("| Phase | Runs | Seconds |");
  // Repeated phases collapse into one summed row; the slowest phase leads and failed timings are excluded.
  expect(summary).toContain("| install | 1 | 12.4 |");
  expect(summary).toContain("| pack | 2 | 3.0 |");
  expect(summary).not.toContain("| publish |");
  const rows = summary.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---") && !line.includes("Phase"));
  expect(rows.map((row) => row.split(" | ")[0]!.slice(2))).toEqual(["install", "bundle", "pack", "snapshot"]);
  expect(summary).toContain("- Cache: deps=local, assets=registry, app=miss (not-found)");
  expect(summary).toContain("- Layers: deps 13.8 MB, assets 10.9 MB, app 0.1 MB (24.8 MB stored)");
  expect(summary).toContain("- Publish: blobs 12 reused, 3 mounted, 5 uploaded; 8.2 MB uploaded; 4121 ms");
  expect(summary).toContain(`- Published: \`ghcr.io/team/api@${digest}\``);
});

test("summary separates platforms and targets and never echoes markup from report labels", () => {
  const report = {
    schemaVersion: 3, status: "success", targets: [
      { ...singleTarget(), target: "api|<img>", platform: "linux/amd64,linux/arm64",
        timings: [timing("install", 9000, "linux/amd64"), timing("install", 21_000, "linux/arm64"), timing("pack", 1000, "linux/amd64"), timing("snapshot", 500)],
        images: [{ platform: { os: "linux", architecture: "amd64" }, layers: [layer("deps", 13_800_000)] }, { platform: { os: "linux", architecture: "arm64" }, layers: [layer("deps", 14_100_000), layer("app", 100_000)] }] },
      { ...singleTarget(), target: "worker", publication: undefined },
    ],
  };
  const summary = renderSummary(report);
  expect(summary).toContain("| Phase | Platform | Runs | Seconds |");
  expect(summary).toContain("| install | linux/arm64 | 1 | 21.0 |");
  expect(summary).toContain("| install | linux/amd64 | 1 | 9.0 |");
  // Timings without a platform stay in one row instead of being duplicated per platform.
  expect(summary).toContain("| snapshot | all | 1 | 0.5 |");
  expect(summary).toContain("- Layers (linux/amd64): deps 13.8 MB (13.8 MB stored)");
  expect(summary).toContain("- Layers (linux/arm64): deps 14.1 MB, app 0.1 MB (14.2 MB stored)");
  expect(summary).toContain("#### worker");
  expect(summary).not.toContain("<img>");
  expect(summary).toContain("api&#124;");
});

test("summary omits publication, tolerates a missing cache array and notes unusable reports", () => {
  const local = singleTarget({ publication: undefined, cache: undefined });
  const summary = renderSummary(local);
  expect(summary).not.toContain("Publish:");
  expect(summary).not.toContain("Published:");
  expect(summary).toContain("- Cache: not reported");
  expect(renderSummary({ ...local, timings: [timing("pack", 10, "linux/amd64", "failed")] })).toContain("No completed phase timings in the report.");
  const failed = renderSummary({ schemaVersion: 3, status: "failed", error: "registry.example rejected the manifest", targets: [], pendingTargets: ["api", "worker"] });
  expect(failed).toContain("Build failed: registry.example rejected the manifest");
  expect(failed).toContain("Targets not built: api, worker");
  expect(renderSummary("not a report")).toBe(summaryNote("The build report was not a JSON object; no summary is available."));
  expect(renderSummary(null)).toContain("### bunko build");
});

test("summary escapes Markdown structure so report strings cannot inject links, images or emphasis", () => {
  const summary = renderSummary(singleTarget({
    target: "![x](https://attacker.example/i.png)",
    cache: [{ kind: "deps", key: digest, status: "miss", reason: "[Click here](https://attacker.example)" }],
    timings: [timing("*emphasis* _phase_", 1000, "linux/amd64")],
  }));
  // No Markdown link or image can survive: every bracket, parenthesis, bang and emphasis marker is escaped.
  expect(summary).not.toMatch(/[^\\]\]\(/);
  expect(summary).toContain("\\!\\[x\\]\\(https://attacker.example/i.png\\)");
  expect(summary).toContain("\\[Click here\\]\\(https://attacker.example\\)");
  expect(summary).toContain("\\*emphasis\\* \\_phase\\_");
  // A backslash in report text is escaped before anything else, so it cannot consume the next escape.
  expect(renderSummary(singleTarget({ target: "back\\\\slash" }))).toContain("back\\\\\\\\slash");
  // References stay verbatim inside a code span, where Markdown syntax is inert.
  expect(renderSummary(singleTarget())).toContain(`- Published: \`ghcr.io/team/api@${digest}\``);
});

test("summary redacts credentials that a report quoted back from a registry", () => {
  const failed = renderSummary({
    schemaVersion: 3, status: "failed", targets: [],
    error: "GET https://user:hunter2@registry.example/v2/token?token=s3cret failed: Bearer abcdefghijklmnopqrstuvwx rejected",
  });
  expect(failed).not.toContain("hunter2");
  expect(failed).not.toContain("s3cret");
  expect(failed).not.toContain("abcdefghijklmnopqrstuvwx");
  expect(failed).toContain("&#60;redacted&#62;");
  // Schemeless URLs keep their host but lose credential-bearing query values.
  expect(renderSummary(singleTarget({ cache: [{ kind: "deps", key: digest, status: "miss", reason: "registry.example/v2/blob?access_token=s3cret" }] }))).not.toContain("s3cret");
});

test("summary caps field lengths, row counts and total bytes", () => {
  const huge = renderSummary(singleTarget({
    cache: [{ kind: "deps", key: digest, status: "miss", reason: "x".repeat(1_100_000) }],
    timings: Array.from({ length: 200 }, (_, index) => timing(`phase-${index}`, (200 - index) * 1000, "linux/amd64")),
  }));
  // A single oversized field is clipped, the table keeps a bounded number of rows, and the whole
  // section stays inside the byte budget GitHub accepts for a step summary.
  expect(huge).toContain("deps=miss (…)");
  expect(huge.length).toBeLessThan(20_000);
  expect(huge).toContain("160 more phase rows omitted.");
  expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(summaryBytes);

  const targets = Array.from({ length: 80 }, (_, index) => ({ ...singleTarget(), target: `target-${index}` }));
  const many = renderSummary({ schemaVersion: 3, status: "success", targets });
  expect(many).toContain("- 30 more targets omitted.");

  // A budget smaller than the rendered section keeps whole lines and says that it was cut short.
  const clipped = renderSummary(singleTarget(), 200);
  expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(200);
  expect(clipped).toContain("### bunko build");
  expect(clipped).toContain("_Summary truncated to fit the job summary size limit._");
});


test("truncated URL userinfo cannot expose a credential prefix", () => {
  const secret = "private-credential-".repeat(100);
  const summary = renderSummary({ target: `https://${secret}@registry.example/app` });
  expect(summary).not.toContain("private-credential");
});

test("tiny summary budgets never overflow even for malformed reports", () => {
  for (const report of [null, {}, { target: "app" }]) {
    for (const limit of [0, 1, 20, 100]) expect(Buffer.byteLength(renderSummary(report, limit))).toBeLessThanOrEqual(limit);
  }
});
