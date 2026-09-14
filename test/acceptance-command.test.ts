import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, checked } from "../scripts/validation/acceptance-command.ts";
import { runInvocation } from "../packages/runtime/invocation.ts";

for (const fixture of [
  { name: "running leader inside an invocation", invocation: true, exits: false, cleanup: false },
  { name: "exited leader inside an invocation", invocation: true, exits: true, cleanup: false },
  { name: "standalone command", invocation: false, exits: false, cleanup: false },
  { name: "cleanup command", invocation: true, exits: true, cleanup: true },
]) test.skipIf(process.platform === "win32")(`acceptance timeout drains descendants: ${fixture.name}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-command-timeout-"));
  const ready = join(root, "helper-pid");
  // A background sleep inherits both output pipes, including after its leader exits.
  const script = `sleep 3 &\nprintf '%s' "$!" > "$1"\nprintf 'stdout-ready\\n'\nprintf 'stderr-ready\\n' >&2\n${fixture.exits ? "exit 0" : "wait"}`;
  const check = async () => {
    const started = performance.now();
    let failure: unknown;
    try { await run(["/bin/sh", "-c", script, "fixture", ready], { timeoutMs: 500, cleanup: fixture.cleanup }); }
    catch (error) { failure = error; }
    expect(await Bun.file(ready).exists()).toBe(true);
    expect(String(failure)).toContain("timed out");
    expect(String(failure)).toContain("stdout-ready");
    expect(String(failure)).toContain("stderr-ready");
    // The old implementation waits for the three-second descendant despite its deadline.
    expect(performance.now() - started).toBeLessThan(2000);
    return 0;
  };
  try {
    if (fixture.invocation) expect(await runInvocation(check)).toBe(0);
    else await check();
  } finally {
    if (await Bun.file(ready).exists()) {
      try { process.kill(Number(await Bun.file(ready).text()), "SIGKILL"); } catch { /* Owned helper already exited. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance commands preserve successful output and ordinary failures", async () => {
  expect(await checked([process.execPath, "-e", 'console.log("done")'])).toBe("done");
  const result = await run([process.execPath, "-e", 'console.error("failed"); process.exit(7)']);
  expect(result).toEqual({ stdout: "", stderr: "failed\n", code: 7 });
});
