import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withCacheLock } from "./cache-lock.ts";

export type AssetFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export const urlAssetLimit = 512 * 1024 ** 2;
const redirectLimit = 4;
export const urlAssetTimeoutMs = 10 * 60_000;
// GitHub serves release assets from sibling hosts, so those hops are accepted as one site.
const githubHosts = new Set(["github.com", "codeload.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "raw.githubusercontent.com"]);

/** HTTPS only, never with credentials, and only same-site or GitHub-style redirects. */
export function assetURL(value: string, origin?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Asset mapping url must be an absolute HTTPS URL: ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) throw new Error(`Asset mapping url must be a plain HTTPS location without credentials or a fragment: ${value}`);
  const host = url.hostname.toLowerCase();
  if (origin !== undefined && host !== origin && !host.endsWith(`.${origin}`) && !(githubHosts.has(origin) && githubHosts.has(host))) throw new Error(`Asset download redirected off its original host: ${origin} to ${host}`);
  return url;
}

/** Stream to a temporary file under a size cap and verify the digest before the bytes are usable. */
async function download(url: string, destination: string, sha256: string, limit: number, fetcher: AssetFetcher, timeoutMs: number): Promise<void> {
  const origin = assetURL(url).hostname.toLowerCase();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = assetURL(url);
    for (let redirects = 0; ; redirects++) {
      // Credentials are never attached; private sources belong in an asset context.
      const response = await fetcher(current.href, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/octet-stream" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        // Never await a discarded body: a stalled peer must not be able to hold the build here.
        void response.body?.cancel().catch(() => {});
        if (!location) throw new Error(`Asset download redirect is missing a location: ${url}`);
        if (redirects >= redirectLimit) throw new Error(`Asset download exceeded ${redirectLimit} redirects: ${url}`);
        current = assetURL(new URL(location, current).href, origin);
        continue;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`Asset download failed (${response.status}): ${url}`); }
      if (!response.body) throw new Error(`Empty asset download response: ${url}`);
      const hash = createHash("sha256"), reader = response.body.getReader(), handle = await open(destination, "wx", 0o600);
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error(`Asset download exceeds the ${limit} byte limit: ${url}`);
          hash.update(value);
          await handle.write(value);
        }
      } finally { await handle.close(); void reader.cancel().catch(() => {}); }
      const digest = `sha256:${hash.digest("hex")}`;
      if (digest !== `sha256:${sha256}`) throw new Error(`Asset checksum mismatch for ${url}: expected sha256:${sha256}, received ${digest}`);
      return;
    }
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Copy a cached file into private build staging through one descriptor, so the bytes that are hashed and
 * packed are the bytes that were verified. A shared cache entry is never read again afterwards. */
async function snapshotFile(source: string, destination: string, sha256: string, limit: number): Promise<number> {
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Asset download cache entry is not a regular file");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const output = await open(destination, "wx", 0o600), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    let size = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > limit) throw new Error(`Asset download exceeds the ${limit} byte limit: sha256:${sha256}`);
        hash.update(buffer.subarray(0, bytesRead));
        await output.write(buffer.subarray(0, bytesRead));
      }
    } finally { await output.close(); }
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== `sha256:${sha256}`) throw new Error(`Asset cache checksum mismatch: expected sha256:${sha256}, received ${digest}`);
    return size;
  } finally { await handle.close(); }
}

/** Content-addressed by the declared digest, so repeated builds neither re-download nor trust the cache blindly. */
export async function urlAssetFile(url: string, sha256: string, options: { cache: string; destination: string; offline?: boolean; fetcher?: AssetFetcher; limit?: number; timeoutMs?: number; log?: (message: string) => void }): Promise<{ path: string; size: number }> {
  assetURL(url);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Asset mapping sha256 must be 64 lowercase hexadecimal characters");
  const limit = options.limit ?? urlAssetLimit, directory = join(options.cache, "downloads", sha256);
  return withCacheLock(directory, async () => {
    const file = join(directory, "asset");
    for (const retry of [false, true]) {
      try { return { path: options.destination, size: await snapshotFile(file, options.destination, sha256, limit) }; }
      catch (error) {
        await rm(options.destination, { force: true });
        if (retry) throw error;
        const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!absent) options.log?.("Asset download cache entry failed verification; fetching a verified replacement\n");
        // Offline reports why the cache could not be used, rather than claiming a present entry is missing.
        if (options.offline) throw absent ? new Error(`Offline builds require a cached URL asset; sha256:${sha256} is missing from the download cache`) : error;
        await rm(file, { force: true });
        options.log?.(`Fetching asset ${url}\n`);
        const staging = join(directory, `.download-${randomUUID()}`);
        try {
          await download(url, staging, sha256, limit, options.fetcher ?? fetch, options.timeoutMs ?? urlAssetTimeoutMs);
          await rename(staging, file);
        } finally { await rm(staging, { force: true }); }
      }
    }
    throw new Error(`Asset download could not be verified: sha256:${sha256}`);
  }, () => true, 35 * 60_000);
}
