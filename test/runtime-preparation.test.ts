import { expect, test } from "bun:test";
import { runtimePreparation } from "../packages/bunko/runtime-preparation.ts";
import type { downloadRuntime } from "../packages/bunko/runtime-download.ts";

const toolchain = { path: "bun", version: "1.3.13", revision: "bf2e2cecf" };
const arm = { os: "linux", architecture: "arm64" } as const;
const x64 = { os: "linux", architecture: "amd64" } as const;

test("runtime preparation shares files, separates assets and isolates metadata", async () => {
  let calls = 0, active = 0, peak = 0;
  const download: typeof downloadRuntime = async (_toolchain, _platform, options) => {
    calls++; peak = Math.max(peak, ++active);
    await Bun.sleep(5); active--;
    return { executable: { source: options.destination, size: 123 }, metadata: { path: "/usr/local/bin/bun", needed: ["libc.so"] } } as Awaited<ReturnType<typeof downloadRuntime>>;
  };
  const prepare = runtimePreparation("/unused-test-scratch", toolchain, { cache: false }, download);
  const [first, duplicate, otherArch, otherLibc] = await Promise.all([prepare(arm, "glibc"), prepare(arm, "glibc"), prepare(x64, "glibc"), prepare(arm, "musl")]);
  expect(calls).toBe(3); expect(peak).toBe(1);
  expect(first.executable).toEqual(duplicate.executable);
  expect(new Set([first, otherArch, otherLibc].map((input) => input.executable.source)).size).toBe(3);
  first.metadata.path = "/custom/bun"; first.metadata.needed.push("changed");
  expect(duplicate.metadata.path).toBe("/usr/local/bin/bun");
  expect((await prepare(arm, "glibc")).metadata.needed).toEqual(["libc.so"]);
  expect(calls).toBe(3);
});

test("failed runtime verification stops queued assets and never returns an input", async () => {
  let calls = 0;
  const failure = new Error("signature rejected");
  const prepare = runtimePreparation("/unused-test-scratch", toolchain, {}, async () => { calls++; throw failure; });
  const results = await Promise.allSettled([prepare(arm, "glibc"), prepare(x64, "glibc"), prepare(arm, "glibc")]);
  expect(calls).toBe(1);
  for (const result of results) { expect(result.status).toBe("rejected"); if (result.status === "rejected") expect(result.reason).toBe(failure); }
});
