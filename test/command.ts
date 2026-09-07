export async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args.slice(0, 3).join(" ")} failed: ${stderr || stdout}`);
  return (args[1] === "logs" ? stdout + stderr : stdout).trim();
}
