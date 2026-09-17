import type { Platform } from "../oci/types.ts";

export function platform(value: string): Platform {
  if (value === "linux/amd64") return { os: "linux", architecture: "amd64" };
  if (value === "linux/arm64" || value === "linux/arm64/v8") return { os: "linux", architecture: "arm64", variant: "v8" };
  throw new Error(`Supported platforms: linux/amd64 or linux/arm64 (received ${value})`);
}

export const platformKey = (value: Platform) => `${value.os}/${value.architecture}/${value.variant ?? ""}`;

/** Docker output targets the local host unless a platform was explicitly selected. */
export function localPlatform(architecture: string = process.arch): string {
  if (architecture === "arm64") return "linux/arm64";
  if (architecture === "x64") return "linux/amd64";
  throw new Error(`Cannot infer a local Linux platform for host architecture ${architecture}; set --platform`);
}
