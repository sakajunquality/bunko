import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCosign, cosignCommand } from "../../packages/bunko/cosign.ts";

// Check the installed real helper's interface separately from permissive unit mocks.
const executable = process.env.BUNKO_COSIGN_PATH ?? "cosign";
await assertCosign(executable, true);
const sign = await cosignCommand(executable, ["sign", "--help"]);
const verify = await cosignCommand(executable, ["verify", "--help"]);
for (const flag of ["--signing-config", "--trusted-root", "--identity-token", "--oidc-provider", "--oidc-disable-ambient-providers"]) if (!sign.includes(flag)) throw new Error(`Real cosign sign lacks ${flag}`);
for (const flag of ["--certificate-identity", "--certificate-identity-regexp", "--certificate-oidc-issuer", "--certificate-oidc-issuer-regexp", "--trusted-root", "--use-signed-timestamps", "--insecure-ignore-tlog"]) if (!verify.includes(flag)) throw new Error(`Real cosign verify lacks ${flag}`);
const root = await mkdtemp(join(tmpdir(), "bunko-cosign-contract-"));
try {
  const endpoint = { url: "https://127.0.0.1:1", majorApiVersion: 1, validFor: { start: "2024-01-01T00:00:00Z" }, operator: "fixture" };
  await writeFile(join(root, "config.json"), JSON.stringify({ mediaType: "application/vnd.dev.sigstore.signingconfig.v0.2+json", caUrls: [endpoint], oidcUrls: [endpoint], tsaUrls: [endpoint], tsaConfig: { selector: "ANY" } }));
  await writeFile(join(root, "root.json"), JSON.stringify({ mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1" }));
  await writeFile(join(root, "token"), "invalid-fixture-jwt", { mode: 0o600 });
  const child = Bun.spawn([executable, "sign", "--yes", "--signing-config", join(root, "config.json"), "--trusted-root", join(root, "root.json"), "--identity-token", join(root, "token"), "--oidc-disable-ambient-providers", `127.0.0.1:1/fixture@sha256:${"a".repeat(64)}`], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { PATH: process.env.PATH } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (!code || child.signalCode || /unknown flag|unknown field|mutually exclusive|unmarshal|invalid signing config|select.*(?:rekor|tlog)/i.test(stderr)) throw new Error("Real cosign rejected the keyless interface or native TSA-only config");
    if (!/token|jwt|connection refused|certificate|trust/i.test(stderr)) throw new Error("Unexpected real cosign negative probe failure");
  } finally { clearTimeout(timer); }
  console.log("Real cosign keyless flags and native TSA-only negative probe passed; live OIDC signing is not verified.");
} finally { await rm(root, { recursive: true, force: true }); }
