import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalOutput } from "../oci/layout.ts";

/** Verified external asset downloads and extracted image subtrees, beside the layer, install and runtime caches. */
export async function assetCachePath(value?: string): Promise<string> {
  return canonicalOutput(value ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "assets", "v1"));
}
