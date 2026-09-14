import { cleanupSpawn, spawn } from "../../packages/runtime/invocation.ts";

/** Bounded subprocesses for the external-tool acceptance experiments. */
export async function run(args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number; cleanup?: boolean } = {}) {
  const child = (options.cleanup ? cleanupSpawn : spawn)(args, {
    cwd: options.cwd, env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 120_000);
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
