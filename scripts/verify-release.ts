import { resolve, join } from "node:path";
import { assetNames, releaseTag } from "./distribution.ts";

export function verificationArguments(path: string, bundle: string, repository: string, sourceRef: string, sourceDigest?: string): string[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((p) => p === "." || p === "..")) throw new Error("Invalid attestation repository");
  if (!/^refs\/(heads\/main|tags\/v[0-9A-Za-z.-]+)$/.test(sourceRef)) throw new Error("Attestation source must be main or an explicit version tag");
  if (sourceDigest !== undefined && !/^[a-f0-9]{40,64}$/.test(sourceDigest)) throw new Error("Invalid attestation source digest");
  return ["attestation", "verify", path, "--bundle", bundle, "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/release.yml`, "--source-ref", sourceRef,
    "--deny-self-hosted-runners", ...sourceDigest ? ["--source-digest", sourceDigest] : []];
}

export async function verifyRelease(directory: string, repository: string, sourceRef: string, sourceDigest?: string, token?: string): Promise<void> {
  const gh = Bun.which("gh", { PATH: process.env.PATH }); if (!gh) throw new Error("Release attestation verification requires the GitHub CLI (gh)");
  for (const name of [...assetNames, "SHA256SUMS"]) {
    const args = verificationArguments(join(directory, name), join(directory, "PROVENANCE.jsonl"), repository, sourceRef, sourceDigest);
    const child = Bun.spawn([gh, ...args], { env: { ...process.env, ...token ? { GH_TOKEN: token } : {} }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    try {
      // Drain diagnostics but do not expose authentication or transport details.
      const [, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (timedOut || code !== 0) throw new Error(`Release attestation verification failed: ${name}`);
    } finally { clearTimeout(timer); }
  }
}

if (import.meta.main) {
  const directory = resolve(process.argv[2] ?? "dist/release"), tag = releaseTag(process.argv[3] ?? "");
  await verifyRelease(directory, process.env.GITHUB_REPOSITORY ?? "sakajunquality/bunko", process.env.BUNKO_ATTESTATION_SOURCE_REF ?? `refs/tags/${tag}`, process.env.BUNKO_ATTESTATION_SOURCE_DIGEST);
  console.log("Verified release artifact provenance and source identity");
}
