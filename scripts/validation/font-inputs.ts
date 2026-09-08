import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const inputs = [
  ["NotoSansCJKjp-Regular.otf", "notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf", "68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5"],
  ["NotoColorEmoji.ttf", "googlefonts/noto-emoji/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/NotoColorEmoji.ttf", "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b"],
  ["OFL.txt", "notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE", "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"],
  ["LICENSE.txt", "googlefonts/noto-emoji/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts/LICENSE", "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"],
] as const;

/** Prepare pinned public font inputs in a new directory; never overwrite user files. */
export async function prepareFontInputs(context: string) {
  await mkdir(context);
  try {
    await mkdir(join(context, "noto"), { recursive: false });
    for (const [name, path, digest] of inputs) {
      const response = await fetch(`https://raw.githubusercontent.com/${path}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error("Cannot download pinned font fixture");
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Font fixture exceeds download bound"); } chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Font fixture checksum mismatch");
      await writeFile(join(context, "noto", name), bytes);
    }
  } catch (error) { await rm(context, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("Usage: bun scripts/validation/font-inputs.ts NEW_DIRECTORY");
  const output = resolve(process.argv[2]!);
  await prepareFontInputs(output);
  console.log(output);
}
