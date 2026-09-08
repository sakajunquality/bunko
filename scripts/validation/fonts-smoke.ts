import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { command } from "../../test/command.ts";

const inputs = [
  ["NotoSansCJKjp-Regular.otf", "notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf", "68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5"],
  ["NotoColorEmoji.ttf", "googlefonts/noto-emoji/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/NotoColorEmoji.ttf", "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b"],
  ["OFL.txt", "notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE", "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"],
  ["LICENSE.txt", "googlefonts/noto-emoji/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/LICENSE", "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"],
] as const;
const root = await mkdtemp(join(tmpdir(), "bunko-fonts-smoke-"));
const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
try {
  const source = join(root, "source"), context = join(root, "inputs");
  await cp(resolve("examples/font-validation"), source, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
  await mkdir(join(context, "noto"), { recursive: true });
  for (const [name, path, digest] of inputs) {
    const response = await fetch(`https://raw.githubusercontent.com/${path}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error("Cannot download pinned font fixture");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Font fixture exceeds download bound"); } chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Font fixture checksum mismatch");
    await writeFile(join(context, "noto", name), bytes);
  }
  for (const platform of platforms) {
    if (!["linux/amd64", "linux/arm64"].includes(platform)) throw new Error("Unsupported font validation platform");
    const archive = join(root, `${platform.split("/")[1]}.tar`);
    await command([process.execPath, resolve("dist/bunko.js"), "build", source, "--platform", platform, "--asset-context", `fonts=${context}`, "--push=false", "--tarball", archive, "--git-metadata=false", "--no-cache"]);
    const loaded = await command(["docker", "load", "--input", archive]);
    const image = /Loaded image: (.+)/.exec(loaded)?.[1]; if (!image) throw new Error("Cannot identify font fixture image");
    try {
      const result = JSON.parse(await command(["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65532:65532", image]));
      if (result.status !== "passed" || result.arch !== (platform.endsWith("amd64") ? "x64" : "arm64")) throw new Error("Font fixture failed");
      console.log(JSON.stringify({ platform, ...result }));
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
