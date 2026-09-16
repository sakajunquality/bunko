import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { credentialHost } from "./credentials.ts";
import { registryHost } from "./registry-host.ts";
import { object } from "./digest.ts";
import { spawn } from "../runtime/invocation.ts";
import { dockerConfigPath } from "./credential-sources.ts";

export type CredentialWriter = (helper: string, operation: "store" | "erase", input: string) => Promise<void>;
const helperName = (name: unknown): string => {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid Docker credential helper name"); return name;
};
async function helperWrite(helper: string, operation: "store" | "erase", input: string): Promise<void> {
  const executable = Bun.which(`docker-credential-${helperName(helper)}`, { PATH: process.env.PATH });
  if (!executable) throw new Error("Docker credential helper is unavailable on PATH");
  const child = spawn([executable, operation], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Credential helper operation timed out")); }, 30_000); });
    const operation = async () => { child.stdin.write(input + "\n"); await child.stdin.end(); return await child.exited; };
    const code = await Promise.race([operation(), deadline]);
    if (code !== 0 || child.signalCode) throw new Error("Credential helper operation failed; configuration was not changed");
  } finally { clearTimeout(timer); }
}
function sameHost(key: string, host: string): boolean {
  try { return registryHost(credentialHost(key), true) === host; } catch { return false; }
}
/** Serialize cooperating bunko writers; external edits are detected best-effort, not atomically. */
export async function editCredentialConfig(file: string, edit: (config: Record<string, unknown>) => Promise<void>): Promise<void> {
  const path = resolve(file), lock = `${path}.bunko-lock`, temporary = `${path}.bunko-${randomUUID()}.tmp`;
  let acquired = false;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); acquired = true; await handle.close();
    let original: string | undefined;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || !(info.mode & 0o222)) throw new Error("unsafe");
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const opened = await input.stat(); if (!opened.isFile() || opened.size > 1024 * 1024) throw new Error(); original = await input.readFile("utf8"); if (Buffer.byteLength(original) > 1024 * 1024) throw new Error(); }
      finally { await input.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Credential configuration must be a writable regular file, not a link"); }
    let config: Record<string, unknown>;
    try { config = original === undefined ? {} : object(JSON.parse(original), "Credential configuration"); }
    catch { throw new Error("Invalid credential configuration JSON; refusing to overwrite it"); }
    await edit(config);
    const output = await open(temporary, "wx", 0o600);
    try { await output.writeFile(JSON.stringify(config, null, 2) + "\n"); await output.sync(); } finally { await output.close(); }
    let current: string | undefined;
    try { if (!(await lstat(path)).isFile()) throw new Error(); current = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Credential configuration changed while editing"); }
    if (current !== original) throw new Error("Credential configuration changed while editing; retry the operation");
    await rename(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("Credential configuration is locked by another bunko writer; remove a stale .bunko-lock only after checking that no writer is running");
    if (code && ["EACCES", "EPERM", "EROFS"].includes(code)) throw new Error("Credential configuration is read-only or not writable; use --config with a writable file");
    if (code) throw new Error("Could not update credential configuration");
    throw error;
  } finally { await rm(temporary, { force: true }); if (acquired) await rm(lock, { force: true }); }
}
export interface LoginOptions { config?: string; username?: string; password?: string; helper?: string; helperWriter?: CredentialWriter }
export async function credentialLogin(input: string, options: LoginOptions, logout = false): Promise<void> {
  const registry = registryHost(input, true), server = registry === "registry-1.docker.io" ? "https://index.docker.io/v1/" : registry;
  if (!logout && options.helper === undefined && (typeof options.username !== "string" || !options.username || /[:\x00-\x20\x7f]/.test(options.username) || typeof options.password !== "string" || !options.password || Buffer.byteLength(options.password) > 256 * 1024 || /[\x00\r\n]/.test(options.password))) throw new Error("login requires a valid username and a single password from --password-stdin");
  if (options.helper !== undefined) { helperName(options.helper); if (logout || options.username !== undefined || options.password !== undefined) throw new Error("--helper registration cannot be combined with a password or logout"); }
  let completedHelperOperation: "store" | "erase" | undefined;
  try { await editCredentialConfig(options.config ?? dockerConfigPath(), async (config) => {
    const auths = config.auths === undefined ? {} : object(config.auths, "auths");
    const helpers = config.credHelpers === undefined ? {} : object(config.credHelpers, "credHelpers");
    const matching = Object.entries(helpers).filter(([key]) => sameHost(key, registry));
    if (matching.length > 1) throw new Error("Ambiguous credential helper entries for registry");
    const perHost = matching[0]?.[1];
    const selected = perHost || config.credsStore;
    if (selected && options.helper === undefined) {
      const helper = helperName(selected), operation = logout ? "erase" : "store";
      const payload = logout ? server : JSON.stringify({ ServerURL: server, Username: options.username, Secret: options.password });
      try { await (options.helperWriter ?? helperWrite)(helper, operation, payload); completedHelperOperation = operation; }
      catch { throw new Error("Credential helper operation failed; configuration was not changed"); }
    }
    for (const key of Object.keys(auths)) if (sameHost(key, registry)) delete auths[key];
    if (options.helper !== undefined) for (const key of Object.keys(helpers)) if (sameHost(key, registry)) delete helpers[key];
    if (options.helper !== undefined) helpers[registry] = options.helper;
    else if (!logout && !selected) auths[server] = { auth: Buffer.from(`${options.username}:${options.password}`).toString("base64") };
    config.auths = auths;
    if (config.credHelpers !== undefined || options.helper !== undefined) config.credHelpers = helpers;
  }); } catch (error) {
    if (completedHelperOperation) throw new Error(`Credential helper ${completedHelperOperation} completed, but the configuration update did not finish successfully; inspect the configuration and retry. Helper changes were not rolled back.`);
    throw error;
  }
}
export async function passwordFromStdin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 256 * 1024) throw new Error("Password input exceeds the size limit"); chunks.push(value); } }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString().replace(/\r?\n$/, "");
}
