import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { X509Certificate } from "node:crypto";

/** Preserve Bun's proxy selection and bypass rules without inheriting unrelated host settings. */
export function installNetworkEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (environment[key] !== undefined) result[key] = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"].includes(key) && environment[key] ? resolve(environment[key]!) : environment[key]!;
  }
  return result;
}


export interface NpmCertificate { pem: string; files: string[] }

/** Read transport trust from the original project, never from a staged relative path. */
export async function npmCertificate(directory: string, validate = true): Promise<NpmCertificate | undefined> {
  let npmrc: string;
  try { npmrc = await readFile(resolve(directory, ".npmrc"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const values = npmrc.split(/\r?\n/).filter((line) => /^\s*cafile\s*=/.test(line)).map((line) => line.slice(line.indexOf("=") + 1).trim());
  if (!values.length) return;
  if (values.length !== 1 || !values[0]) throw new Error("npm cafile must be specified once with a nonempty path");
  if (!validate) return;
  const value = values[0]!.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = process.env[name];
    if (!value || /[\r\n\0]/.test(value)) throw new Error("Missing or invalid npm cafile environment variable");
    return value;
  });
  try {
    const path = resolve(directory, value), canonical = await realpath(path);
    return { pem: await certificatePEM(canonical), files: [...new Set([path, canonical])] };
  } catch { throw new Error("npm cafile must reference a readable PEM certificate bundle of at most 1 MiB"); }
}

/** Reject private keys and arbitrary files when combining installer trust bundles. */
export async function certificatePEM(path: string, label = "Installer CA"): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    const pem = await readFile(path, "utf8");
    const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certificates = pem.match(pattern);
    if (!certificates?.length || Buffer.byteLength(pem) > 1024 * 1024 || /-----BEGIN |-----END /.test(pem.replace(pattern, ""))) throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
    return certificates.join("\n") + "\n";
  } catch { throw new Error(`${label} must be a readable PEM certificate bundle of at most 1 MiB`); }
}
