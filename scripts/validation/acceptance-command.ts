import { cleanupSpawn, spawn } from "../../packages/runtime/invocation.ts";

/** Bounded subprocesses for the external-tool acceptance experiments. */
export async function run(args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number; cleanup?: boolean } = {}) {
  const grouped = process.platform !== "win32";
  const child = (options.cleanup ? cleanupSpawn : spawn)(args, {
    cwd: options.cwd, env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    // Own a process group even when called outside runInvocation.
    detached: grouped,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Descendants can keep output pipes open after the leader exits. Signal its group regardless.
    try {
      if (grouped) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    }
  }, options.timeoutMs ?? 120_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) throw new Error(`${args[0]} ${args[1]} timed out:\n${stdout}${stderr}`);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

export async function checked(args: string[], options: Parameters<typeof run>[1] = {}) {
  const result = await run(args, options);
  if (result.code !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.code}):\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}
