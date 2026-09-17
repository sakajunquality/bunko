import { expect, test } from "bun:test";
import { mapJobs } from "../packages/bunko/concurrency.ts";
import { cleanupAfterTasks, invocationSignal, pause, spawn } from "../packages/runtime/invocation.ts";

test("failed target cancels nested cooperating work, drains it and preserves the first error", async () => {
  const failure = new Error("target failed");
  let ready!: () => void, drained = false;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const unrelated = pause(50).then(() => "unrelated completed");
  await expect(mapJobs([0, 1, 2], 2, async (value) => {
    if (value === 0) { await started; throw failure; }
    if (value === 2) throw new Error("must not start");
    try {
      return await mapJobs([1], 1, async () => { ready(); await pause(30_000); return 1; });
    } finally { drained = true; }
  }, { cancelOnFailure: true })).rejects.toBe(failure);
  expect(drained).toBe(true);
  expect(await unrelated).toBe("unrelated completed");
  expect(invocationSignal()).toBeUndefined();
  expect(await mapJobs([1], 1, async (value) => value, { cancelOnFailure: true })).toEqual([1]);
});

test("failed target kills a sibling subprocess that ignores SIGTERM before returning", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let child: Bun.Subprocess | undefined, drained = false;
  const failure = new Error("original target error"), start = Date.now();
  await expect(mapJobs([0, 1], 2, async (value) => {
    if (value === 0) { await started; throw failure; }
    child = spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000);'], { stdout: "pipe", stderr: "ignore" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("ready"); ready();
      while (!(await reader.read()).done) { /* Drain all output before cleanup. */ }
      await child.exited; drained = true;
    } finally { reader.releaseLock(); child.kill(); }
  }, { cancelOnFailure: true })).rejects.toBe(failure);
  expect(drained).toBe(true);
  expect(child!.signalCode).toBe("SIGKILL");
  expect(Date.now() - start).toBeLessThan(5000);
}, 10_000);


test.skipIf(process.platform === "win32")("leader exit does not release cancellation of descendants retaining pipes", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let child: Bun.Subprocess | undefined, drained = false;
  const failure = new Error("target failed after leader exit");
  const start = Date.now();
  try {
    await expect(mapJobs([0, 1], 2, async (value) => {
      if (value === 0) { await started; throw failure; }
      child = spawn(["sh", "-c", "sleep 30 & echo ready"], { stdout: "pipe", stderr: "ignore" });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
        expect(await child.exited).toBe(0); ready();
        while (!(await reader.read()).done) { /* Drain descendant-held output. */ }
        drained = true;
      } finally { reader.releaseLock(); }
    }, { cancelOnFailure: true })).rejects.toBe(failure);
    expect(drained).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  } finally { if (child) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } } }
}, 10_000);


test.skipIf(process.platform === "win32")("target cleanup waits for redirected descendants that ignore SIGTERM", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let child: Bun.Subprocess | undefined, cleaned = false;
  const failure = new Error("first target failed");
  try {
    await expect(mapJobs([0, 1], 2, async (value) => {
      if (value === 0) { await started; throw failure; }
      child = spawn(["sh", "-c", `sh -c 'trap "" TERM; sleep 30' >/dev/null 2>&1 & echo ready; wait`], { stdout: "pipe", stderr: "ignore" });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
        await Bun.sleep(100); ready();
        while (!(await reader.read()).done) { /* Drain leader output. */ }
        await child.exited;
      } finally {
        reader.releaseLock();
        await cleanupAfterTasks(async () => {
          expect(() => process.kill(-child!.pid, 0)).toThrow();
          cleaned = true;
        });
      }
    }, { cancelOnFailure: true })).rejects.toBe(failure);
    expect(cleaned).toBe(true);
  } finally { if (child) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } } }
}, 10_000);


test.skipIf(process.platform === "win32")("first failing target defers cleanup until its own helper is gone", async () => {
  let child: Bun.Subprocess | undefined, cleaned = false;
  const failure = new Error("first failure");
  try {
    await expect(mapJobs([0], 1, async () => {
      child = spawn(["sh", "-c", `sh -c 'trap "" TERM; sleep 30' >/dev/null 2>&1 & sleep 0.1; exit 1`], { stdout: "ignore", stderr: "ignore" });
      try { expect(await child.exited).toBe(1); throw failure; }
      finally {
        await cleanupAfterTasks(async () => {
          expect(() => process.kill(-child!.pid, 0)).toThrow();
          cleaned = true;
        });
      }
    }, { cancelOnFailure: true })).rejects.toBe(failure);
    expect(cleaned).toBe(true);
  } finally { if (child) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } } }
}, 10_000);
