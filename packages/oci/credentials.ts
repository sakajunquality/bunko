import { runWithDeadline } from "../runtime/invocation.ts";
import { registryHost } from "./registry-host.ts";
import { registryAuthHelp } from "./auth-help.ts";
import { spawn } from "../runtime/invocation.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { object } from "./digest.ts";

export interface Credential { helper?: { name: string; server: string }; expires?: number; source?: string; username?: string; password?: string; identityToken?: string; registryToken?: string }
export type CredentialProvider = ((registry: string, refresh?: boolean) => Promise<Credential | undefined>) & { bridge?: boolean; sensitivePaths?: string[] };
export type HelperRunner = (helper: string, server: string) => Promise<Credential | undefined>;

export function credentialHost(key: string): string {
  const value = key.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return ["docker.io", "index.docker.io"].includes(value) ? "registry-1.docker.io" : value;
}

async function runHelper(helper: string, server: string): Promise<Credential | undefined> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(helper)) throw new Error("Invalid Docker credential helper name");
  const binary = Bun.which(`docker-credential-${helper}`);
  if (!binary) throw new Error(`Docker credential helper not found: docker-credential-${helper}. Install it on PATH for the Bunko process. ${registryAuthHelp(server)}`);
  const child = spawn([binary, "get"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(`${server}\n`);
  child.stdin.end();
  try {
    const [stdout, stderr, code] = await runWithDeadline(child, Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), 30_000, "Credential helper");
    if (code !== 0) {
      if (/credentials not found in native keychain|credentials not found in native keyring|no credentials/i.test(stdout + stderr)) return;
      // Helper output can contain secrets; never echo it in an error.
      throw new Error(`Docker credential helper ${helper} failed (exit ${code})`);
    }
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(stdout), "Credential helper response"); } catch { throw new Error("Invalid Docker credential helper response"); }
    if (typeof value.Username !== "string" || typeof value.Secret !== "string" || !value.Secret) throw new Error("Incomplete Docker credential helper response");
    return value.Username === "<token>" ? { identityToken: value.Secret } : { username: value.Username, password: value.Secret };
  } finally { /* Output readers are bounded by the process deadline. */ }
}

/** Docker's per-registry helper > global store > auths precedence, without writing credentials. */
export function dockerCredentials(file = process.env.BUNKO_DOCKER_CONFIG ?? join(process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), "config.json"), helper: HelperRunner = runHelper, configured?: () => void, normalizeHosts = false): CredentialProvider {
  const cache = new Map<string, Promise<Credential | undefined>>();
  async function resolve(registry: string): Promise<Credential | undefined> {
    let config: Record<string, unknown>;
    try { config = object(JSON.parse(await readFile(file, "utf8")), "Docker config"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Cannot read Docker credential configuration"); }
    return configuredCredentials(config, registry, helper, configured, normalizeHosts);
  }

  return (registry, refresh) => {
    if (refresh) cache.delete(registry);
    let value = cache.get(registry);
    if (!value) { value = resolve(registry); cache.set(registry, value); }
    return value;
  };
}

export async function configuredCredentials(config: Record<string, unknown>, registry: string, helper: HelperRunner = runHelper, configured?: () => void, normalizeHosts = false): Promise<Credential | undefined> {
    const matches = (key: string): boolean => {
      try { return (normalizeHosts ? registryHost(credentialHost(key), true) : credentialHost(key)) === registry; } catch { return false; }
    };
    const matchingEntry = (entries: Record<string, unknown>): [string, unknown] | undefined => {
      const found = Object.entries(entries).filter(([key]) => matches(key));
      if (normalizeHosts && found.length > 1) throw new Error("Ambiguous credential entries for registry");
      return found[0];
    };
    const helpers = config.credHelpers === undefined ? {} : object(config.credHelpers, "credHelpers");
    const auths = config.auths === undefined ? {} : object(config.auths, "auths");
    for (const key of [...Object.keys(helpers), ...Object.keys(auths)]) {
      if (matches(key) && key.replace(/^https?:\/\//, "").replace(/\/$/, "").includes("/") && key !== "https://index.docker.io/v1/") throw new Error("Repository-scoped credentials cannot be used as host-wide credentials");
    }
    const perRegistry = matchingEntry(helpers)?.[1];
    const selected = perRegistry === "" || perRegistry === undefined ? (config.credsStore === "" ? undefined : config.credsStore) : perRegistry;
    if (selected !== undefined) {
      if (typeof selected !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(selected)) throw new Error("Invalid Docker credential helper name");
      configured?.();
      const server = registry === "registry-1.docker.io" ? "https://index.docker.io/v1/" : registry;
      const credential = await helper(selected, server);
      return credential && normalizeHosts ? { ...credential, helper: { name: selected, server } } : credential;
    }
    const entry = matchingEntry(auths);
    if (!entry) return;
    configured?.();
    const auth = object(entry[1], "Docker auth entry");
    if (typeof auth.registrytoken === "string" && auth.registrytoken) return { registryToken: auth.registrytoken };
    if (typeof auth.identitytoken === "string" && auth.identitytoken) return { identityToken: auth.identitytoken };
    if (typeof auth.auth === "string" && auth.auth) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(auth.auth)) throw new Error("Invalid Docker auth encoding");
      const decoded = Buffer.from(auth.auth, "base64").toString();
      const colon = decoded.indexOf(":");
      if (colon < 1) throw new Error("Invalid Docker auth entry");
      return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
    }
    if (typeof auth.username === "string" && typeof auth.password === "string") return { username: auth.username, password: auth.password };
}
