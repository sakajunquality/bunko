import { command } from "./command.ts";

/** Retry only the idempotent prerequisite pull, never a container run. */
export async function pullImage(reference: string, platform?: string, run = command, sleep: (ms: number) => Promise<unknown> = Bun.sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(["docker", "pull", ...(platform ? ["--platform", platform] : []), reference]); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !/\b(?:429|500|502|503|504)\b|too many requests|timeout|timed out|connection reset|unexpected EOF/i.test(message)) throw error;
      process.stderr.write(`Retrying Docker pull (${attempt + 2}/3)\n`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}
