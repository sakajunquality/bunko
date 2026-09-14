import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";

// Release asset SHA256 values from the upstream v1.22.1 release.
const checksums: Record<string, string> = {
  "darwin-arm64": "ba00172029ecec3afda7fd93a5eee7cdaef710196df7103689da3386eba56b0a",
  "darwin-amd64": "1ca7265ed9061785a39cda83d5a8104c769bbf432dab40a269596ea6f1a13c45",
  "linux-arm64": "801826ed107222120eb6df8c143b7de752cfebbe3aebfeea576e7098486917c2",
  "linux-amd64": "fa35e89512a8978585f76cf41397956d2e3a30c62c2ad3fb857b1597074d14ca",
};
const destination = process.argv[2];
if (!destination || process.argv.length !== 3) throw new Error("Usage: bun scripts/validation/install-structure-test.ts DESTINATION");
const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
const expected = checksums[platform];
if (!expected) throw new Error(`Unsupported structure-test host: ${platform}`);
const url = `https://github.com/GoogleContainerTools/container-structure-test/releases/download/v1.22.1/container-structure-test-${platform}`;
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Structure-test download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Structure-test checksum mismatch");
await writeFile(destination, bytes, { flag: "wx", mode: 0o755 });
await chmod(destination, 0o755);
console.log(`Installed container-structure-test v1.22.1 for ${platform}`);
