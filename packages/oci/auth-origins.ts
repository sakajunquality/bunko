import { object } from "./digest.ts";
import { registryHost } from "./registry-host.ts";

/** Explicit token-service origins, scoped to the registry whose credentials may be sent. */
export function registryAuthOrigins(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null);
  for (const [host, entries] of Object.entries(object(value, "Registry authOrigins"))) {
    const registry = registryHost(host);
    if (Object.hasOwn(result, registry)) throw new Error("Duplicate normalized authentication registry");
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) throw new Error("Registry authOrigins must contain arrays of exact origins");
    result[registry] = [...new Set(entries.map((entry) => {
      let url: URL;
      try { url = new URL(entry); } catch { throw new Error("Invalid registry authentication origin"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Registry authentication origins must not contain paths, credentials, queries or fragments");
      registryHost(url.host);
      return url.origin;
    }))];
  }
  return result;
}

/** Docker Hub has a separate well-known token service; other registries default to their own origin. */
export function defaultAuthOrigins(registry: string): string[] {
  return registry === "registry-1.docker.io" ? ["https://auth.docker.io"] : [];
}
