import { invocationSignal, throwIfCancelled, pause } from "../runtime/invocation.ts";
import { spawn, mkdtemp } from "../runtime/invocation.ts";
import { runtimePins } from "./runtime-pins.ts";
import { canonicalOutput } from "../oci/layout.ts";
import { constants } from "node:fs";
import { runtimeNotices } from "./runtime-notices.ts";
import { fromBufferPromise } from "yauzl";
import { open, writeFile, rm, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "../oci/digest.ts";
import type { Digest, Platform } from "../oci/types.ts";
import type { Toolchain } from "./toolchain.ts";
import { runtimeKey, runtimeSigner } from "./runtime-key.ts";
import { withCacheLock } from "./cache-lock.ts";

const archiveLimit = 128 * 1024 ** 2, executableLimit = 256 * 1024 ** 2, manifestLimit = 1024 ** 2;
export const runtimePolicy = "bun-release-gpg-pinned-v1";
export interface InjectedRuntime {
  source: "github-release"; version: string; expectedRevision: string; releaseRevision: string; revisionVerified: false;
  checksumDocumentDigest: Digest; noticeDigest: Digest; archiveDigest: Digest; executableDigest: Digest; url: string; signer: string; policy: string;
  asset: string; libc: "glibc"; cpu: string; path: string;
  interpreter: string; needed: string[]; glibcSymbols: string[];
}
export function runtimeAsset(toolchain: Toolchain, platform: Platform) {
  if (!Object.hasOwn(runtimePins, toolchain.version) || !/^[a-f0-9]{7,40}$/.test(toolchain.revision)) throw new Error(`Verified runtime selection supports official Bun releases: ${Object.keys(runtimePins).join(", ")}`);
  if (platform.os !== "linux" || !["amd64", "arm64"].includes(platform.architecture)) throw new Error("Unsupported verified runtime platform");
  return `bun-linux-${platform.architecture === "amd64" ? "x64-baseline" : "aarch64"}`;
}

export function assertSignatureStatus(status: string, code: number): void {
const valid = status.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
if (/\[GNUPG:\] (?:EXPKEYSIG|REVKEYSIG|EXPSIG|BADSIG|ERRSIG|NO_PUBKEY)\b/.test(status) || code || valid.length !== 1 || ![valid[0]!.split(" ")[2], valid[0]!.trim().split(" ").at(-1)].includes(runtimeSigner)) throw new Error("Bun release signature verification failed");
}

/** Verify only against the embedded key; gpgv cannot use an ambient trust store. */
export async function verifiedChecksums(signed: Uint8Array): Promise<string> {
  if (signed.length > manifestLimit) throw new Error("Runtime checksum document exceeds size limit");
  const executable = Bun.which("gpgv");
  if (!executable) throw new Error("Verified runtime selection requires gpgv (install GnuPG); unsigned verification is not supported");
  const root = await mkdtemp(join(tmpdir(), "bunko-runtime-signature-"));
  try {
    await writeFile(join(root, "trusted.gpg"), Buffer.from(runtimeKey, "base64"), { mode: 0o600 });
    await writeFile(join(root, "checksums.asc"), signed, { mode: 0o600 });
    const child = spawn([executable, "--homedir", root, "--keyring", join(root, "trusted.gpg"), "--status-fd", "1", join(root, "checksums.asc")],
      { cwd: root, env: { HOME: root, GNUPGHOME: root, PATH: process.env.PATH ?? "", LANG: "C" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [status, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      assertSignatureStatus(status, code);
      const text = Buffer.from(signed).toString("utf8").replaceAll("\r\n", "\n");
      const match = /^-----BEGIN PGP SIGNED MESSAGE-----\nHash: [A-Z0-9, ]+\n\n([\s\S]*?)\n-----BEGIN PGP SIGNATURE-----\n/.exec(text);
      if (!match) throw new Error("Expected a clear-signed Bun checksum document");
      return match[1]!.split("\n").map((line) => line.startsWith("- ") ? line.slice(2) : line).join("\n");
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
export function archiveChecksum(text: string, asset: string): Digest {
  const names = new Map<string, string>();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || names.has(match[2]!)) throw new Error("Invalid or duplicate signed runtime checksum entry");
    names.set(match[2]!, match[1]!);
  }
  const hash = names.get(`${asset}.zip`);
  if (!hash) throw new Error("Selected runtime asset is absent from signed checksums");
  return `sha256:${hash}`;
}

export async function runtimeCachePath(value?: string): Promise<string> {
  return canonicalOutput(value ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "runtime", "v1"));
}
export function pinnedArchiveChecksum(version: string, asset: string, text: string): Digest {
  const digest = archiveChecksum(text, asset);
  if (runtimePins[version]?.[asset] !== digest) throw new Error("Signed runtime checksum disagrees with the pinned release version");
  return digest;
}
export function releaseRevision(bytes: Buffer, toolchain: Toolchain): string {
  const marker = Buffer.from(`\0${toolchain.revision}`);
  for (let cursor = 0; cursor < bytes.length;) {
    const at = bytes.indexOf(marker, cursor); if (at < 0) break; cursor = at + 1;
    const revision = bytes.subarray(at + 1, at + 41).toString("ascii");
    if (/^[a-f0-9]{40}$/.test(revision) && bytes[at + 41] === 0) return revision;
  }
  throw new Error("Official runtime does not contain the selected toolchain revision; custom builds cannot use official runtime assets");
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
/** Restart bounded downloads after transient connection/body failures. Never forward credentials. */
export async function runtimeBytes(url: string, limit: number, fetcher: Fetcher = fetch): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5 * 60_000);
    let retry = true;
    try {
      let current = new URL(url);
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (current.protocol !== "https:" || current.port || current.username || current.password || current.hash || !["github.com", "release-assets.githubusercontent.com"].includes(current.hostname)) { retry = false; throw new Error("Unexpected runtime release download origin"); }
        const response = await fetcher(current.href, { redirect: "manual", signal: invocationSignal(controller.signal), headers: { Accept: "application/octet-stream" } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location"); await response.body?.cancel();
          if (!location || redirects === 5) { retry = false; throw new Error("Invalid runtime release redirect"); }
          current = new URL(location, current); continue;
        }
        if (!response.ok) { retry = [408, 429, 500, 502, 503, 504].includes(response.status); await response.body?.cancel(); throw new Error(`Runtime release download failed (${response.status})`); }
        if (!response.body) throw new Error("Empty runtime release response");
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > limit) { retry = false; throw new Error("Runtime release download exceeds size limit"); }
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return Buffer.concat(chunks);
      }
      throw new Error("Runtime release redirect failed");
    } catch (error) {
      if (!retry || attempt >= 2) throw new Error(error instanceof Error && /^(Runtime|Unexpected|Invalid|Empty)/.test(error.message) ? error.message : "Runtime release connection or body transfer failed");
    } finally { clearTimeout(timer); }
    await pause(100 * (attempt + 1));
  }
}

export async function extractRuntime(bytes: Buffer, asset: string): Promise<Buffer> {
  if (bytes.length > archiveLimit) throw new Error("Runtime archive exceeds size limit");
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  let executable: Buffer | undefined;
  const seen = new Set<string>();
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName, type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (seen.has(name) || ![`${asset}/`, `${asset}/bun`].includes(name) || entry.isEncrypted() || (type && type !== (name.endsWith("/") ? 0o040000 : 0o100000))) throw new Error("Unexpected, duplicate or non-regular runtime ZIP entry");
      seen.add(name);
      if (name.endsWith("/")) { if (entry.uncompressedSize) throw new Error("Invalid runtime ZIP directory"); continue; }
      if (!entry.uncompressedSize || entry.uncompressedSize > executableLimit) throw new Error("Runtime executable exceeds size limit");
      const stream = await zip.openReadStreamPromise(entry), chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of stream) { size += chunk.length; if (size > executableLimit) throw new Error("Runtime executable exceeds size limit"); chunks.push(chunk); }
      } finally { stream.destroy(); }
      if (size !== entry.uncompressedSize) throw new Error("Runtime executable size mismatch");
      executable = Buffer.concat(chunks);
    }
  } finally { zip.close(); }
  if (!executable) throw new Error("Runtime ZIP does not contain the expected executable");
  return executable;
}

export function runtimeELF(bytes: Buffer, platform: Platform) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString() !== "\x7fELF" || bytes[4] !== 2 || bytes[5] !== 1 || ![0, 3].includes(bytes[7]!) || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== (platform.architecture === "amd64" ? 62 : 183)) throw new Error("Verified runtime is not a target Linux ELF64 executable");
  const num = (offset: number) => { const n = Number(bytes.readBigUInt64LE(offset)); if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid runtime ELF offset"); return n; };
  const phoff = num(32), width = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (width !== 56 || !count || count > 1024 || phoff + width * count > bytes.length) throw new Error("Invalid runtime ELF program headers");
  const segments: { type: number; offset: number; address: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const p = phoff + width * i, segment = { type: bytes.readUInt32LE(p), offset: num(p + 8), address: num(p + 16), size: num(p + 32) };
    if (segment.offset + segment.size > bytes.length) throw new Error("Truncated runtime ELF segment"); segments.push(segment);
  }
  const string = (offset: number, end: number) => { const zero = bytes.indexOf(0, offset); if (offset < 0 || zero < offset || zero >= end) throw new Error("Invalid runtime ELF string"); return bytes.subarray(offset, zero).toString("utf8"); };
  const interp = segments.filter((s) => s.type === 3);
  if (interp.length !== 1) throw new Error("Runtime must declare one ELF interpreter");
  const interpreter = string(interp[0]!.offset, interp[0]!.offset + interp[0]!.size);
  const expected = platform.architecture === "amd64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
  if (interpreter !== expected) throw new Error("Runtime is not the expected glibc executable");
  const dynamic = segments.find((s) => s.type === 2), neededOffsets: number[] = []; let strings = 0, length = 0;
  if (!dynamic || dynamic.size > 1024 * 1024 || dynamic.size % 16) throw new Error("Invalid runtime ELF dynamic table");
  for (let p = dynamic.offset; p < dynamic.offset + dynamic.size; p += 16) {
    const tag = num(p), value = num(p + 8); if (!tag) break;
    if (tag === 1) neededOffsets.push(value); if (tag === 5) strings = value; if (tag === 10) length = value;
  }
  const table = segments.find((s) => s.type === 1 && strings >= s.address && strings + length <= s.address + s.size);
  if (!table || !length) throw new Error("Invalid runtime ELF string table");
  const start = table.offset + strings - table.address;
  const needed = neededOffsets.map((n) => { if (n >= length) throw new Error("Invalid runtime ELF dependency"); return string(start + n, start + length); });
  // These are declared symbol-version names, not proof that the base can satisfy them.
  const glibcSymbols = [...new Set(bytes.subarray(start, start + length).toString("latin1").match(/GLIBC_[0-9]+(?:\.[0-9]+)+/g) ?? [])].sort();
  return { interpreter, needed, glibcSymbols };
}

export async function downloadRuntime(toolchain: Toolchain, platform: Platform, options: { cache?: string | false; offline?: boolean; fetcher?: Fetcher; log?: (message: string) => void } = {}) {
  if (!Bun.which("gpgv")) throw new Error("Verified runtime selection requires gpgv (install GnuPG); unsigned verification is not supported");
  const asset = runtimeAsset(toolchain, platform), base = `https://github.com/oven-sh/bun/releases/download/bun-v${toolchain.version}`;
  const ephemeral = options.cache === false ? await mkdtemp(join(tmpdir(), "bunko-runtime-cache-")) : undefined;
  const cache = ephemeral ?? await runtimeCachePath(typeof options.cache === "string" ? options.cache : undefined);
  try {
    return await withCacheLock(join(cache, `${toolchain.version}-${asset}`), async () => {
      const directory = join(cache, `${toolchain.version}-${asset}`);
      async function cached(name: string, limit: number, verify: (b: Buffer) => Promise<void>) {
        const path = join(directory, name);
        try {
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > limit) throw new Error("Invalid runtime cache entry");
            const chunks: Buffer[] = []; let size = 0;
            for (;;) {
              const chunk = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(chunk);
              if (!bytesRead) break;
              size += bytesRead; if (size > limit) throw new Error("Invalid runtime cache entry"); chunks.push(chunk.subarray(0, bytesRead));
            }
            bytes = Buffer.concat(chunks);
          } finally { await handle.close(); }
          await verify(bytes); return bytes;
        } catch (error) {
          if (options.offline) throw new Error("Offline runtime cache entry is missing or invalid; prepare the verified runtime while online");
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.log?.("Runtime download cache entry failed verification; fetching a verified replacement\n");
        }
        options.log?.(`Fetching signed runtime release asset ${name}\n`);
        const bytes = await runtimeBytes(`${base}/${name}`, limit, options.fetcher); await verify(bytes);
        const staging = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(staging, bytes, { mode: 0o600, flag: "wx" }); await rename(staging, path); }
        finally { await rm(staging, { force: true }); }
        return bytes;
      }
      let digest!: Digest, checksumDocumentDigest!: Digest;
      await cached("SHASUMS256.txt.asc", manifestLimit, async (bytes) => { digest = pinnedArchiveChecksum(toolchain.version, asset, await verifiedChecksums(bytes)); checksumDocumentDigest = sha256(bytes); });
      const archive = await cached(`${asset}.zip`, archiveLimit, async (bytes) => { if (sha256(bytes) !== digest) throw new Error("Runtime archive checksum mismatch"); });
      const executable = await extractRuntime(archive, asset), elf = runtimeELF(executable, platform);
      // An authenticated official archive must contain the selected toolchain identity.
      // Actual --revision execution is deliberately left to check-base --run.
      const revision = releaseRevision(executable, toolchain);
      return { executable, metadata: { source: "github-release", version: toolchain.version, expectedRevision: toolchain.revision, releaseRevision: revision, revisionVerified: false, checksumDocumentDigest, noticeDigest: sha256(Buffer.from(runtimeNotices[toolchain.version]!)), archiveDigest: digest, executableDigest: sha256(executable), url: `${base}/${asset}.zip`, signer: runtimeSigner, policy: runtimePolicy, asset, libc: "glibc", cpu: platform.architecture === "amd64" ? "x64-baseline" : "aarch64", path: "/usr/local/bin/bun", ...elf } satisfies InjectedRuntime };
    }, () => true, 35 * 60_000);
  } finally { if (ephemeral) await rm(ephemeral, { recursive: true, force: true }); }
}
