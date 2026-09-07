import { expect, test } from "bun:test";
import { conformanceOptions, validateRepository } from "./registry-conformance.ts";
import { pullImage } from "./docker-pull.ts";

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
