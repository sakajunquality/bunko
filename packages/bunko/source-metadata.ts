import { spawn } from "../runtime/invocation.ts";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Normalize common Git transports to a source URL without credentials or URL state. */
export function sourceURL(remote: string): string | undefined {
  if (/[\x00-\x20\x7f\\]/.test(remote) || /^[a-zA-Z]:/.test(remote)) return;
  try {
    const scp = /^(?:[^/@:]+@)?([a-zA-Z0-9.-]+):(.+)$/.exec(remote);
    const value = scp && !remote.includes("://") ? `ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, "")}` : remote;
    let url = new URL(value);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return;
    if (url.protocol === "ssh:" || url.protocol === "git:") { url = new URL(`https://${url.hostname}${url.pathname}`); }
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    return url.pathname && url.pathname !== "/" ? url.toString() : undefined;
  } catch { return; }
}

async function inCheckout(directory: string): Promise<boolean> {
  for (let current = directory; ; current = dirname(current)) {
    try { await lstat(join(current, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    if (dirname(current) === current) return false;
  }
}

/** Optional Git metadata must never claim a clean tree when status could not be read. */
export async function gitLabels(directory: string, log?: (message: string) => void, executable = Bun.which("git")): Promise<Record<string, string>> {
  if (!await inCheckout(directory)) return {};
  const warn = () => log?.("Git metadata is incomplete; check repository ownership and Git safe.directory configuration, or use --git-metadata=false.\n");
  if (!executable) { warn(); return {}; }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete (env as NodeJS.ProcessEnv)[key];
  const run = async (args: string[]) => {
    try {
      const child = spawn([executable, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args], { stdout: "pipe", stderr: "ignore", env });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return exit === 0 ? stdout.trim() : undefined;
      } finally { clearTimeout(timer); }
    } catch { return; }
  };
  const revision = await run(["rev-parse", "HEAD"]);
  if (!revision || !/^[a-f0-9]{40,64}$/.test(revision)) { warn(); return {}; }
  const result: Record<string, string> = { "org.opencontainers.image.revision": revision };
  // Status may invoke clean/process filters, including filters in submodule repositories.
  // Preserve revision/source, but do not claim a clean tree when safe inspection is unavailable.
  const configNames = await run(["config", "--null", "--name-only", "--list"]);
  const index = await run(["ls-files", "--stage", "-z"]);
  const safeStatus = configNames !== undefined && index !== undefined
    && !configNames.split("\0").some((name) => /^filter\..*\.(clean|process)$/.test(name))
    && !index.split("\0").some((entry) => entry.startsWith("160000 "));
  const status = safeStatus ? await run(["status", "--porcelain", "--untracked-files=normal"]) : undefined;
  if (status === undefined) warn(); else result["org.bunko.git.dirty"] = String(Boolean(status));
  const remote = await run(["remote", "get-url", "origin"]), source = remote ? sourceURL(remote) : undefined;
  if (source) result["org.opencontainers.image.source"] = source;
  return result;
}


export function revisionTag(labels: Record<string, string>): string | undefined {
  const revision = labels["org.opencontainers.image.revision"], dirty = labels["org.bunko.git.dirty"];
  if (!revision || !["true", "false"].includes(dirty ?? "")) return undefined;
  return revision.slice(0, 12) + (dirty === "true" ? "-dirty" : "");
}
