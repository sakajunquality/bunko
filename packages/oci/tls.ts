import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { object } from "./digest.ts";

export interface RegistryTLS { ca?: string; cert?: string; key?: string }

/** Certificate material is loaded once and scoped to exact HTTPS origins. */
export async function registryTLS(file: string): Promise<{ hosts: Record<string, RegistryTLS>; files: string[] }> {
  const configDirectory = dirname(resolve(file));
  file = await realpath(file);
  const value = object(JSON.parse(await readFile(file, "utf8")), "Registry TLS configuration");
  const result: Record<string, RegistryTLS> = {};
  const files = [resolve(file)];
  for (const [host, raw] of Object.entries(value)) {
    const origin = new URL(`https://${host}`);
    if (origin.host !== host.toLowerCase() && origin.host + ":443" !== host.toLowerCase() || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Registry TLS keys must be registry hosts with optional ports");
    if (result[origin.origin]) throw new Error("Duplicate normalized Registry TLS host");
    const fields = object(raw, "Registry TLS host"), tls: RegistryTLS = {};
    if (!Object.keys(fields).length || Object.keys(fields).some((name) => !["ca", "cert", "key"].includes(name))) throw new Error("Registry TLS accepts ca, cert and key paths only");
    if (Boolean(fields.cert) !== Boolean(fields.key)) throw new Error("Registry TLS requires both cert and key");
    for (const name of ["ca", "cert", "key"] as const) if (fields[name] !== undefined) {
      if (typeof fields[name] !== "string" || !fields[name]) throw new Error("Registry TLS certificate paths must be nonempty strings");
      const path = await realpath(resolve(configDirectory, fields[name]));
      if (!(await lstat(path)).isFile()) throw new Error("Registry TLS certificate paths must be regular files");
      tls[name] = await readFile(path, "utf8");
      files.push(path);
      if (!tls[name]!.includes("-----BEGIN ")) throw new Error("Registry TLS requires PEM data");
    }
    result[origin.origin] = tls;
  }
  return { hosts: result, files };
}
