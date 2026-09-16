import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "../runtime/invocation.ts";
import { canonicalJSON, object, sha256 } from "../oci/digest.ts";
import { parseReference } from "../oci/source.ts";
import { assertCosign, cosignCommand } from "./cosign.ts";
import { signImages } from "./attest.ts";

export interface SigningOptions { sign?: "key" | "keyless"; signKey?: string; signIdentityToken?: string; sigstoreConfig?: string; signTlog?: boolean }
export interface SigningMetadata { mode: "key" | "keyless"; service?: "public" | "custom"; tlog: boolean; configDigest?: string }
export interface PreparedSigning { metadata: SigningMetadata; paths: string[]; key?: string; token?: string; provider?: string; config?: Uint8Array; root?: Uint8Array; client?: string }
export function signingMode(options: SigningOptions): "key" | "keyless" | undefined {
  if (options.sign !== undefined && !["key", "keyless"].includes(options.sign)) throw new Error("--sign must be key or keyless");
  const mode = options.sign ?? (options.signKey ? "key" : undefined);
  if (mode === "key" && !options.signKey || mode === "keyless" && options.signKey) throw new Error("Key signing requires --sign-key; keyless cannot use --sign-key");
  if (mode !== "keyless" && (options.signIdentityToken !== undefined || options.sigstoreConfig !== undefined || options.signTlog !== undefined)) throw new Error("Identity token, Sigstore config and tlog options require --sign keyless");
  return mode;
}
async function bytes(path: string, limit: number): Promise<Uint8Array> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > limit) throw new Error();
    const data = await readFile(path); if (data.length > limit) throw new Error(); return data;
  } catch { throw new Error("Signing input must be a bounded regular file"); }
}
function json(data: Uint8Array): Record<string, unknown> {
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)), "Signing configuration"); }
  catch { throw new Error("Invalid signing configuration JSON"); }
}
function urls(config: Record<string, unknown>, field: string): string[] {
  const value = config[field] ?? [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid Sigstore service list");
  return value.map((entry) => {
    const raw = object(entry, "Sigstore service").url;
    if (typeof raw !== "string") throw new Error("Invalid Sigstore endpoint");
    let url: URL; try { url = new URL(raw); } catch { throw new Error("Invalid Sigstore endpoint"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\x00-\x20]/.test(raw)) throw new Error("Sigstore endpoints require HTTPS without credentials, queries or fragments");
    return raw;
  });
}
export async function sigstoreProfile(path: string) {
  const raw = await bytes(path, 64 * 1024), wrapper = json(raw);
  if (wrapper.schemaVersion !== 1 || Object.keys(wrapper).some((key) => !["schemaVersion", "signingConfig", "trustedRoot", "oidcClientId"].includes(key))
      || typeof wrapper.signingConfig !== "string" || !wrapper.signingConfig || typeof wrapper.trustedRoot !== "string" || !wrapper.trustedRoot
      || wrapper.oidcClientId !== undefined && (typeof wrapper.oidcClientId !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(wrapper.oidcClientId))) throw new Error("Invalid Sigstore profile");
  const paths = [resolve(path), resolve(dirname(path), wrapper.signingConfig), resolve(dirname(path), wrapper.trustedRoot)];
  const config = await bytes(paths[1]!, 1024 * 1024), root = await bytes(paths[2]!, 1024 * 1024), value = json(config);
  if (value.mediaType !== "application/vnd.dev.sigstore.signingconfig.v0.2+json" || Object.keys(value).some((key) => !["mediaType", "caUrls", "oidcUrls", "rekorTlogUrls", "tsaUrls", "rekorTlogConfig", "tsaConfig"].includes(key))) throw new Error("Unsupported Sigstore signing config");
  if (!urls(value, "caUrls").length || !urls(value, "oidcUrls").length) throw new Error("Custom Sigstore config requires Fulcio and OIDC services");
  const tlog = urls(value, "rekorTlogUrls").length > 0, tsa = urls(value, "tsaUrls").length > 0;
  if (json(root).mediaType !== "application/vnd.dev.sigstore.trustedroot+json;version=0.1") throw new Error("Unsupported Sigstore trusted root");
  return { config, root, paths, tlog, tsa, client: wrapper.oidcClientId as string | undefined, digest: sha256(canonicalJSON({ config: value, root: json(root), client: wrapper.oidcClientId ?? "sigstore" })) };
}
export async function prepareSigning(options: SigningOptions): Promise<PreparedSigning | undefined> {
  const mode = signingMode(options); if (!mode) return;
  if (mode === "key") return { metadata: { mode, tlog: false }, paths: [], key: options.signKey };
  const profile = options.sigstoreConfig ? await sigstoreProfile(options.sigstoreConfig) : undefined;
  const tlog = options.signTlog ?? true;
  if (tlog && profile && !profile.tlog) throw new Error("A TSA-only profile requires explicit --sign-tlog=false");
  if (!tlog && (!profile?.tsa || profile.tlog)) throw new Error("Disabling keyless tlog requires a custom config with TSA and no Rekor services");
  const paths = [...profile?.paths ?? []];
  let token = options.signIdentityToken ?? process.env.SIGSTORE_ID_TOKEN ?? process.env.CI_JOB_JWT_V2;
  if (options.signIdentityToken?.startsWith("@")) { const path = resolve(options.signIdentityToken.slice(1)); token = Buffer.from(await bytes(path, 64 * 1024)).toString().trim(); paths.push(path); }
  if (token !== undefined && (!token || token.length > 64 * 1024 || /\s/.test(token))) throw new Error("Invalid explicit identity token");
  const provider = !token ? process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ? "github-actions"
    : process.env.BUILDKITE_AGENT_ACCESS_TOKEN ? "buildkite-agent" : process.env.GOOGLE_APPLICATION_CREDENTIALS ? "google" : undefined : undefined;
  if (!token && !provider) throw new Error("No keyless identity: configure Actions id-token: write, an ambient provider, or an explicit identity token");
  return { metadata: { mode, service: profile ? "custom" : "public", tlog, ...(profile ? { configDigest: profile.digest } : {}) }, paths, token, provider, config: profile?.config, root: profile?.root, client: profile?.client };
}
export async function signConfiguredImages(references: string[], signing: PreparedSigning, executable = "cosign", insecure: string[] = []): Promise<void> {
  if (signing.metadata.mode === "key") return signImages(references, signing.key!, executable, insecure);
  await assertCosign(executable, true);
  const images = [...new Set(references)].map((reference) => { const ref = parseReference(reference); if (!ref.reference.startsWith("sha256:")) throw new Error("Signing requires immutable image digests"); return { reference, ref }; });
  const directory = await mkdtemp(join(tmpdir(), "bunko-keyless-"));
  try {
    const args = ["sign", "--yes"];
    for (const [value, name, flag] of [[signing.config, "config.json", "--signing-config"], [signing.root, "root.json", "--trusted-root"], [signing.token ? Buffer.from(signing.token) : undefined, "token", "--identity-token"]] as const) if (value) {
      const path = join(directory, name); await writeFile(path, value, { mode: 0o600, flag: "wx" }); args.push(flag, path);
    }
    if (signing.client) args.push("--oidc-client-id", signing.client);
    if (signing.provider) args.push("--oidc-provider", signing.provider);
    else args.push("--oidc-disable-ambient-providers");
    for (const { reference, ref } of images) await cosignCommand(executable, [...args, ...(insecure.includes(ref.registry) ? ["--allow-http-registry"] : []), reference], 120_000, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export interface CertificateOptions { identity?: string; identityRegexp?: string; issuer?: string; issuerRegexp?: string; sigstoreConfig?: string; useSignedTimestamps?: boolean }
export async function verifyKeylessImage(reference: string, options: CertificateOptions, executable = "cosign", insecure: string[] = []): Promise<void> {
  if (Boolean(options.identity) === Boolean(options.identityRegexp) || Boolean(options.issuer) === Boolean(options.issuerRegexp)) throw new Error("Keyless verification requires exactly one certificate identity and one OIDC issuer constraint");
  for (const value of [options.identity, options.identityRegexp, options.issuer, options.issuerRegexp]) if (value !== undefined && (!value || value.length > 4096 || /[\x00\r\n]/.test(value))) throw new Error("Invalid certificate constraint");
  const ref = parseReference(reference); if (!ref.reference.startsWith("sha256:")) throw new Error("Signature verification requires an immutable image digest");
  const profile = options.sigstoreConfig ? await sigstoreProfile(options.sigstoreConfig) : undefined;
  await assertCosign(executable, true);
  const directory = await mkdtemp(join(tmpdir(), "bunko-keyless-verify-"));
  try {
    const args = ["verify", ...(insecure.includes(ref.registry) ? ["--allow-http-registry"] : [])];
    for (const [name, value] of [["certificate-identity", options.identity], ["certificate-identity-regexp", options.identityRegexp], ["certificate-oidc-issuer", options.issuer], ["certificate-oidc-issuer-regexp", options.issuerRegexp]] as const) if (value) args.push(`--${name}`, value);
    if (profile) { const path = join(directory, "root.json"); await writeFile(path, profile.root, { mode: 0o600, flag: "wx" }); args.push("--trusted-root", path); }
    if (profile && !profile.tlog) {
      if (!profile.tsa) throw new Error("Keyless verification without Rekor requires a TSA profile");
      args.push("--insecure-ignore-tlog", "--use-signed-timestamps");
    } else if (options.useSignedTimestamps) args.push("--use-signed-timestamps");
    await cosignCommand(executable, [...args, reference]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
