import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { throwIfCancelled } from "../runtime/invocation.ts";
import { downloadRuntime, runtimeAsset } from "./runtime-download.ts";
import type { Libc } from "./libc.ts";
import type { Toolchain } from "./toolchain.ts";
import type { Platform } from "../oci/types.ts";

/** Share authenticated inputs within one build. Serialize verification so archive
 * and ELF buffers are transient, rather than multiplied by target concurrency.
 * The caller owns the scratch directory until every consumer has drained. */
export function runtimePreparation(directory: string, toolchain: Toolchain,
  options: Omit<Parameters<typeof downloadRuntime>[2], "destination" | "libc">,
  download = downloadRuntime) {
  const inputs = new Map<string, ReturnType<typeof downloadRuntime>>();
  let previous: Promise<unknown> = Promise.resolve();
  return async (platform: Platform, libc: Libc) => {
    const key = runtimeAsset(toolchain, platform, libc);
    let input = inputs.get(key);
    if (!input) {
      input = previous.then(() => {
        throwIfCancelled();
        return download(toolchain, platform, { ...options, libc, destination: join(directory, `verified-runtime-${randomUUID()}`) });
      });
      inputs.set(key, input);
      previous = input;
    }
    // Destination and other image-specific metadata must never mutate a shared input.
    return structuredClone(await input);
  };
}
