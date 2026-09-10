import { verifyRelease } from "./verify-release.ts";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNames, localAsset, maxAssetBytes, releaseTag, verifyAssets } from "./distribution.ts";

type Fetcher = (url: URL, init?: RequestInit) => Promise<Response>;
interface SetupOptions { verifyAttestation?: boolean; sourceCommit?: string; version: string; repository?: string; token?: string; distribution?: string; temporary?: string; fetcher?: Fetcher }

/** Follow HTTPS asset redirects without forwarding the GitHub token off-origin. */
export async function githubBytes(url: URL, token: string | undefined, accept: string, fetcher: Fetcher = fetch): Promise<Uint8Array> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5 * 60_000);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid release download URL");
      const headers = new Headers({ Accept: accept, "X-GitHub-Api-Version": "2026-03-10" });
      if (token && url.origin === "https://api.github.com") headers.set("Authorization", `Bearer ${token}`);
      let response: Response;
      try { response = await fetcher(url, { headers, redirect: "manual", signal: controller.signal }); }
      catch { throw new Error("GitHub release connection failed"); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location"); await response.body?.cancel();
        if (!location || redirects === 5) throw new Error("Invalid release download redirect");
        url = new URL(location, url); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub release download failed (${response.status}); check the version and repository access`); }
      if (!response.body) throw new Error("Empty release response");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > maxAssetBytes) throw new Error("Release asset exceeds size limit");
          chunks.push(value);
        }
      } finally { try { await reader.cancel(); reader.releaseLock(); } catch { /* Preserve the read result. */ } }
      return Buffer.concat(chunks);
    }
    throw new Error("Too many release redirects");
  } finally { clearTimeout(timer); }
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Last resort for local runs where neither the Action ref nor an Action checkout is available. */
export const fallbackVersion = "v0.1.2";
type PackageVersionReader = (path: string) => Promise<string | undefined>;
const actionPackageVersion: PackageVersionReader = async (path) => {
  try { const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown }; return typeof parsed?.version === "string" ? parsed.version : undefined; }
  catch { return undefined; }
};
const candidateTag = (value: string | undefined, requirePrefix: boolean) => {
  if (!value || (requirePrefix && !value.startsWith("v"))) return undefined;
  try { return releaseTag(value); } catch { return undefined; }
};

/** Resolve the release to install: an explicit input, then a version-shaped ref for this Action, then its checkout version, then the built-in default. */
export async function resolveVersion(env: Record<string, string | undefined>, readPackageVersion: PackageVersionReader = actionPackageVersion): Promise<{ version: string; source: string }> {
  const explicit = env.INPUT_VERSION?.trim();
  if (explicit) return { version: explicit, source: "the version input" };
  // Only the ref's spelling is available here: the runner reports the requested ref without distinguishing tags from branches, so any version-shaped ref
  // selects that release and anything else falls through to the checkout it resolved to. A ref reported for a different Action repository belongs to a
  // wrapping Action and never names a release here.
  const repository = env.INPUT_REPOSITORY?.trim() || "sakajunquality/bunko";
  // Keep the ref and repository from the same context; a wrapper's ref must never
  // borrow this Action's repository identity from a different environment source.
  const context = env.BUNKO_ACTION_REF?.trim()
    ? { ref: env.BUNKO_ACTION_REF.trim(), repository: env.BUNKO_ACTION_REPOSITORY?.trim() }
    : { ref: env.GITHUB_ACTION_REF?.trim(), repository: env.GITHUB_ACTION_REPOSITORY?.trim() };
  const ref = context.repository?.toLowerCase() === repository.toLowerCase() ? candidateTag(context.ref, true) : undefined;
  if (ref) return { version: ref, source: "GITHUB_ACTION_REF" };
  const actionPath = env.GITHUB_ACTION_PATH?.trim() || env.BUNKO_ACTION_PATH?.trim();
  const checkout = actionPath ? candidateTag((await readPackageVersion(join(actionPath, "package.json")))?.trim(), false) : undefined;
  if (checkout) return { version: checkout, source: "the Action checkout package.json" };
  return { version: fallbackVersion, source: "the built-in default" };
}

export async function setup(options: SetupOptions) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("setup-bunko currently supports Linux and macOS runners");
  if (options.sourceCommit && (!options.verifyAttestation || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.sourceCommit))) throw new Error("source-commit requires attestation verification and a full commit digest");
  const tag = releaseTag(options.version), repository = options.repository ?? "sakajunquality/bunko";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new Error("Invalid release repository");
  let load: (name: string) => Promise<Uint8Array>;
  if (options.distribution) load = (name) => localAsset(options.distribution!, name);
  else {
    const metadata = JSON.parse(Buffer.from(await githubBytes(new URL(`https://api.github.com/repos/${repository}/releases/tags/${tag}`), options.token, "application/vnd.github+json", options.fetcher)).toString());
    if (metadata.tag_name !== tag || metadata.draft || !Array.isArray(metadata.assets)) throw new Error("Unexpected GitHub release metadata");
    load = (name) => {
      const assets = metadata.assets.filter((asset: { name?: string }) => asset.name === name);
      if (assets.length !== 1 || typeof assets[0].url !== "string") throw new Error(`Missing or ambiguous release asset: ${name}`);
      const url = new URL(assets[0].url);
      if (url.origin !== "https://api.github.com" || !url.pathname.toLowerCase().startsWith(`/repos/${repository.toLowerCase()}/releases/assets/`)) throw new Error("Unexpected release asset endpoint");
      return githubBytes(url, options.token, "application/octet-stream", options.fetcher);
    };
  }
  const hashes = Buffer.from(await load("SHA256SUMS")).toString(), assets = new Map<string, Uint8Array>();
  for (const name of assetNames) assets.set(name, await load(name));
  verifyAssets(hashes, assets);
  const root = await mkdtemp(join(options.temporary ?? tmpdir(), "bunko-"));
  try {
    if (/[\r\n]/.test(root)) throw new Error("Installation path contains a newline");
    for (const [name, bytes] of assets) await writeFile(join(root, name), bytes, { flag: "wx" });
    if (options.verifyAttestation) {
      await writeFile(join(root, "SHA256SUMS"), hashes, { flag: "wx" });
      await writeFile(join(root, "PROVENANCE.jsonl"), await load("PROVENANCE.jsonl"), { flag: "wx" });
      await verifyRelease(root, repository, `refs/tags/${tag}`, options.sourceCommit, options.token);
    }
    const child = Bun.spawn([process.execPath, join(root, "bunko.js"), "version"], { cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit || stderr || stdout !== `${tag.slice(1)}\n`) throw new Error("Downloaded CLI version does not match the requested release");
    const bin = join(root, "bin"); await mkdir(bin);
    const executable = join(bin, "bunko");
    await writeFile(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, "bunko.js"))} "$@"\n`, { flag: "wx", mode: 0o755 });
    await chmod(executable, 0o755);
    return { root, bin, executable, version: tag.slice(1) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  if (process.env.INPUT_VERIFY_ATTESTATION && !["true", "false"].includes(process.env.INPUT_VERIFY_ATTESTATION)) throw new Error("verify-attestation must be true or false");
  const selected = await resolveVersion(process.env);
  console.log(`Selected bunko ${selected.version} from ${selected.source}`);
  const result = await setup({ verifyAttestation: process.env.INPUT_VERIFY_ATTESTATION === "true", sourceCommit: process.env.INPUT_SOURCE_COMMIT || undefined, version: selected.version, repository: process.env.INPUT_REPOSITORY,
    token: process.env.INPUT_TOKEN, distribution: process.env.INPUT_DISTRIBUTION_DIRECTORY || undefined, temporary: process.env.RUNNER_TEMP });
  if (process.env.GITHUB_PATH) await appendFile(process.env.GITHUB_PATH, `${result.bin}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nbunko-path=${result.executable}\n`);
  console.log(`Installed bunko ${result.version} at ${result.executable}`);
}
