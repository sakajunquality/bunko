import { command } from "./command.ts";
import { expect, test } from "bun:test";
import { cliBuild, conformanceOptions, validateRepository } from "./registry-conformance.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicationError } from "../packages/oci/publish.ts";
import { pullImage } from "./docker-pull.ts";

test("released CLI failures retain partial publication without copying stderr into reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bunko-cli-report-"));
  const output = join(directory, "report.json");
  try {
    const publication = { published: false, pendingTags: ["test"], completedTags: [], reference: "registry.example/test@sha256:" + "a".repeat(64), tags: [], transfers: [], blobs: { reused: 0, mounted: 0, uploaded: 0, wouldUpload: 0 }, elapsedMs: 12 };
    const script = `await Bun.write(process.argv[1], JSON.stringify({status:"failed",publication:${JSON.stringify(publication)}})); process.exit(2);`;
    try {
      await cliBuild([process.execPath, "-e", script, output], output);
      throw new Error("Expected the CLI to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationError);
      expect((error as PublicationError).result).toEqual(publication);
      expect((error as Error).message).toBe("Released CLI build failed (exit 2)");
    }
    await rm(output);
    await expect(cliBuild([process.execPath, "-e", "process.exit(1)"], output)).rejects.toThrow("Released CLI build failed (exit 1)");
    await expect(cliBuild([process.execPath, "-e", "process.exit(0)"], output)).rejects.toThrow("successful build report");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["ghcr", "ghcr.io/owner/bunko-conformance"],
  ["gar", "asia-northeast1-docker.pkg.dev/project/repository/bunko"],
  ["dockerhub", "docker.io/owner/bunko-conformance"],
  ["ecr", "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/bunko"],
  ["ecr", "123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/bunko"],
] as const)("accepts an explicit %s repository", (vendor, repo) => {
  expect(validateRepository(vendor, repo)).toBe(repo);
});

test.each(["owner/app", "ghcr.io/owner/app:latest", "ghcr.io/owner/app@sha256:aaa", "docker.io/library/busybox", "ghcr.io/owner"])("rejects ambiguous or mismatched destinations: %s", (repo) => {
  expect(() => validateRepository("ghcr", repo)).toThrow();
});

test("requires explicit destinations, report paths, and a shared Docker credential configuration", () => {
  expect(() => conformanceOptions({})).toThrow("BUNKO_SMOKE_VENDOR");
  const env = { BUNKO_SMOKE_VENDOR: "ghcr", BUNKO_SMOKE_REPO: "ghcr.io/owner/app" };
  expect(() => conformanceOptions(env)).toThrow("BUNKO_SMOKE_REPORT");
  const complete = { ...env, BUNKO_SMOKE_REPORT: "/tmp/report.json" };
  expect(conformanceOptions(complete).requireCache).toBe(true);
  expect(() => conformanceOptions({ ...complete, BUNKO_SMOKE_CACHE_REPO: "docker.io/owner/cache" })).toThrow();
  expect(() => conformanceOptions({ ...complete, BUNKO_DOCKER_CONFIG: "/tmp/config.json" })).toThrow("DOCKER_CONFIG");
  expect(() => conformanceOptions({ ...complete, BUNKO_SMOKE_PLATFORMS: "linux/amd64,linux/amd64" })).toThrow("Duplicate");
  expect(() => conformanceOptions({ ...complete, BUNKO_SMOKE_REQUIRE_CACHE: "yes" })).toThrow();
});

test("retries transient prerequisite pulls without retrying authentication failures", async () => {
  const calls: string[][] = [], delays: number[] = [];
  await pullImage("registry:3", undefined, async (args) => { calls.push(args); if (calls.length < 3) throw new Error("HTTP 500 Internal Server Error"); return "ready"; }, async (ms) => { delays.push(ms); });
  expect(calls).toEqual(Array(3).fill(["docker", "pull", "registry:3"]));
  expect(delays).toEqual([1000, 2000]);
  let attempts = 0;
  await expect(pullImage("private/image", "linux/amd64", async () => { attempts++; throw new Error("unauthorized: authentication required"); })).rejects.toThrow("unauthorized");
  expect(attempts).toBe(1);
  attempts = 0;
  await expect(pullImage("registry:3", undefined, async () => { attempts++; throw new Error("HTTP 503"); }, async () => {})).rejects.toThrow("503");
  expect(attempts).toBe(3);
});

test("subprocesses receive credential environment updates made after earlier commands", async () => {
  const original = process.env.BUNKO_TEST_COMMAND_ENV;
  const args = [process.execPath, "-e", "console.log(process.env.BUNKO_TEST_COMMAND_ENV ?? 'unset')"];
  try {
    delete process.env.BUNKO_TEST_COMMAND_ENV;
    expect(await command(args)).toBe("unset");
    process.env.BUNKO_TEST_COMMAND_ENV = "updated-after-first-spawn";
    expect(await command(args)).toBe("updated-after-first-spawn");
  } finally {
    if (original === undefined) delete process.env.BUNKO_TEST_COMMAND_ENV;
    else process.env.BUNKO_TEST_COMMAND_ENV = original;
  }
});
