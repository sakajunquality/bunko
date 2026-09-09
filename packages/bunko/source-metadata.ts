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
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  const run = async (args: string[]) => {
    try {
      const child = Bun.spawn([executable, "-C", directory, ...args], { stdout: "pipe", stderr: "ignore", env });
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
  const status = await run(["status", "--porcelain", "--untracked-files=normal"]);
  if (status === undefined) warn(); else result["org.bunko.git.dirty"] = String(Boolean(status));
  const remote = await run(["remote", "get-url", "origin"]), source = remote ? sourceURL(remote) : undefined;
  if (source) result["org.opencontainers.image.source"] = source;
  return result;
}
