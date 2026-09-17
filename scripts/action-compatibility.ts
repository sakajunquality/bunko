/** Minimum release shared by the build/rebase Actions; setup is independently versioned. */
export const minimumActionCLI = "0.10.0";

export function assertActionVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Bun.semver.satisfies(version, `>=${minimumActionCLI} <1`)) throw new Error(`This Action requires bunko >=${minimumActionCLI} <1; setup installed ${/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "an unrecognized version"}. Set setup-bunko's version input explicitly.`);
}
async function inspect(executable: string, argument: string): Promise<string> {
  const child = Bun.spawn([executable, argument], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    let text = "";
    for await (const chunk of child.stdout) { text += Buffer.from(chunk).toString(); if (text.length > 128 * 1024) { child.kill("SIGKILL"); throw new Error("CLI preflight output exceeds limit"); } }
    if (await child.exited || child.signalCode) throw new Error("Could not inspect installed bunko; install a supported release with setup-bunko");
    return text.trim();
  } finally { clearTimeout(timer); }
}
export async function assertActionCLI(executable: string, args: string[]): Promise<void> {
  assertActionVersion(await inspect(executable, "version"));
  if (args.includes("--smoke-load-timeout") && !(await inspect(executable, "--help")).includes("--smoke-load-timeout")) throw new Error("The installed bunko does not support --smoke-load-timeout; install a release containing that feature or omit the timeout input");
}
