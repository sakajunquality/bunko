import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { configuredCredentials, type Credential, type HelperRunner } from "./credentials.ts";
import { object } from "./digest.ts";

export function podmanConfigPaths(env: Record<string, string | undefined>): string[] {
  if (env.REGISTRY_AUTH_FILE !== undefined) { if (!env.REGISTRY_AUTH_FILE) throw new Error("REGISTRY_AUTH_FILE must not be empty"); return [env.REGISTRY_AUTH_FILE]; }
  const persistent = join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "containers/auth.json");
  return process.platform === "linux" || env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, "containers/auth.json"), persistent] : [persistent];
}
export async function podmanCredentials(registry: string, env: Record<string, string | undefined>, helper?: HelperRunner, claimed?: () => void): Promise<Credential | undefined> {
  for (const path of podmanConfigPaths(env)) {
    let config: Record<string, unknown>;
    try { if ((await stat(path)).size > 1024 * 1024) throw new Error(); config = object(JSON.parse(await readFile(path, "utf8")), "Podman auth configuration"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && env.REGISTRY_AUTH_FILE === undefined) continue; throw new Error("Cannot read Podman credential configuration"); }
    let configured = false;
    const credential = await configuredCredentials(config, registry, helper, () => { configured = true; claimed?.(); }, true);
    if (configured) return credential;
    if (credential) return credential;
  }
}
