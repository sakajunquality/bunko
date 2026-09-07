import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNames, localAsset, maxAssetBytes, releaseTag, verifyAssets } from "./distribution.ts";

type Fetcher = (url: URL, init?: RequestInit) => Promise<Response>;
interface SetupOptions { version: string; repository?: string; token?: string; distribution?: string; temporary?: string; fetcher?: Fetcher }

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

export async function setup(options: SetupOptions) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("setup-bunko currently supports Linux and macOS runners");
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
  const result = await setup({ version: process.env.INPUT_VERSION ?? "v0.1.0-alpha.1", repository: process.env.INPUT_REPOSITORY,
    token: process.env.INPUT_TOKEN, distribution: process.env.INPUT_DISTRIBUTION_DIRECTORY || undefined, temporary: process.env.RUNNER_TEMP });
  if (process.env.GITHUB_PATH) await appendFile(process.env.GITHUB_PATH, `${result.bin}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nbunko-path=${result.executable}\n`);
  console.log(`Installed bunko ${result.version} at ${result.executable}`);
}
