import { spawn, mkdtemp } from "../runtime/invocation.ts";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Preserve credential-helper and proxy settings, but not alternate signature
 * destinations or public-service overrides. Never expose raw helper output. */
export function signingEnvironment(): Record<string, string> {
  const env: Record<string, string> = { HOME: homedir(), PATH: process.env.PATH ?? "" };
  const allowed = ["HOME", "PATH", "COSIGN_PASSWORD", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined &&
    /^(AWS_|GOOGLE_|CLOUDSDK_|AZURE_|ARM_|VAULT_|DOCKER_)/.test(key)) env[key] = value;
  return env;
}

function diagnostic(stderr: string): string {
  if (/x509|certificate|tls handshake/i.test(stderr)) return "TLS trust failure";
  if (/unauthorized|authentication required|access denied|forbidden/i.test(stderr)) return "registry authentication or permission failure";
  if (/no matching signatures|signature verification|invalid signature/i.test(stderr)) return "signature verification failure";
  if (/decrypt|password|private key|public key|key format/i.test(stderr)) return "key loading or password failure";
  return "check key configuration, registry credentials and cosign compatibility";
}

export async function cosignCommand(executable: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const env = signingEnvironment();
  let directory: string | undefined;
  try {
    if (args[0] !== "version" && process.env.BUNKO_DOCKER_CONFIG) {
      directory = await mkdtemp(join(tmpdir(), "bunko-sign-auth-"));
      await writeFile(join(directory, "config.json"), await readFile(process.env.BUNKO_DOCKER_CONFIG), { mode: 0o600, flag: "wx" });
      env.DOCKER_CONFIG = directory;
    }
    let child;
    try { child = spawn([executable, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
    catch { throw new Error("Unable to start cosign; use cosign on PATH or --cosign-path"); }
    let timedOut = false;
    const readers = [child.stdout.getReader(), child.stderr.getReader()];
    const capture = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const chunks: Uint8Array[] = []; let retained = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          const bytes = value.subarray(0, Math.max(0, 64 * 1024 - retained));
          if (bytes.length) { chunks.push(bytes.slice()); retained += bytes.length; }
        }
      } catch { /* A deadline closes captured streams as well as the child. */ }
      return Buffer.concat(chunks).toString();
    };
    const timer = setTimeout(() => {
      timedOut = true; child.kill("SIGKILL");
      for (const reader of readers) void reader.cancel().catch(() => {});
    }, timeoutMs);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, capture(readers[0]!), capture(readers[1]!)]);
      if (timedOut) throw new Error(`cosign ${args[0]} timed out`);
      if (code !== 0 || child.signalCode) throw new Error(`cosign ${args[0]} failed (${child.signalCode ? "terminated by signal" : `exit ${code}`}): ${diagnostic(stderr)}`);
      return stdout;
    } finally { clearTimeout(timer); for (const reader of readers) reader.releaseLock(); }
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

export async function assertCosign(executable = "cosign"): Promise<void> {
  const stdout = await cosignCommand(executable, ["version", "--json"], 10_000);
  let version: unknown;
  try { version = JSON.parse(stdout).gitVersion; } catch { /* Invalid helper output must not be reflected. */ }
  const match = typeof version === "string" && /^v?(\d+)\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || Number(match[1]) < 3) throw new Error("Signing and verification require a stable cosign version 3 or newer (validated with 3.1.3)");
}
