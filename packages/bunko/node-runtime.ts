import { parseReference } from "../oci/source.ts";
import { baseNode, type BaseFilesystem } from "./runtime-layer.ts";
import type { Libc } from "./libc.ts";

export function runtimeKind(value: unknown): "bun" | "node" {
  if (value === undefined || value === "bun") return "bun";
  if (value !== "node") throw new Error("runtime.kind must be bun or node");
  return value;
}
/** Select a declared major, not a verified version of arbitrary base contents. */
export function nodeMajor(value: unknown, engine?: unknown): string {
  if (value !== undefined) {
    if (value !== "22" && value !== "24") throw new Error("runtime.node must be the supported major 22 or 24");
    return value;
  }
  if (engine !== undefined) {
    if (typeof engine !== "string") throw new Error("engines.node must be a range");
    for (const major of ["24", "22"]) if (Bun.semver.satisfies(`${major}.0.0`, engine)) return major;
    throw new Error("Cannot select a Node major from engines.node; set runtime.node explicitly and verify the base version");
  }
  return "24";
}
export function nodeBase(major: string, libc: Libc): string { return libc === "musl" ? `node:${major}-alpine` : `gcr.io/distroless/nodejs${major}-debian13`; }
export function nodePath(base: string | undefined, layout: string | undefined, explicit: unknown, libc: Libc): string {
  if (explicit !== undefined) { if (typeof explicit !== "string" || !explicit.startsWith("/") || explicit.endsWith("/") || /[\x00\r\n\\]/.test(explicit) || explicit.split("/").some((part) => part === "." || part === "..")) throw new Error("runtime.nodePath must be an absolute executable path"); return explicit; }
  if (!base && !layout) return libc === "musl" ? "/usr/local/bin/node" : "/nodejs/bin/node";
  if (base) {
    const ref = parseReference(base);
    if (ref.registry === "gcr.io" && /^distroless\/nodejs(?:22|24)-debian13$/.test(ref.repository)) return "/nodejs/bin/node";
    if (ref.registry === "registry-1.docker.io" && ref.repository === "library/node") return "/usr/local/bin/node";
  }
  throw new Error("Custom Node bases and local layouts require runtime.nodePath (or --runtime-path for check-base)");
}
export function assertNodeExecutable(tree: BaseFilesystem, path: string) {
  const node = baseNode(tree, path);
  if (!node || node.type !== "file" || !node.size || !(node.mode & 0o111)) throw new Error("Node base is missing the configured executable; set runtime.nodePath and run check-base --run");
}
const booleans = new Set(["--expose-gc", "--no-deprecation", "--throw-deprecation", "--trace-deprecation", "--no-warnings", "--trace-warnings", "--use-system-ca", "--use-openssl-ca", "--use-bundled-ca", "--zero-fill-buffers", "--no-addons", "--cpu-prof", "--heap-prof"]);
const valued = new Set(["--max-old-space-size", "--max-semi-space-size", "--stack-size", "--max-http-header-size", "--dns-result-order", "--title", "--unhandled-rejections", "--conditions", "--cpu-prof-dir", "--cpu-prof-name", "--heap-prof-dir", "--heap-prof-name"]);
export function nodeArguments(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!, equal = argument.indexOf("="), flag = equal < 0 ? argument : argument.slice(0, equal);
    if (booleans.has(flag) && equal < 0) { result.push(flag); continue; }
    if (valued.has(flag)) { const value = equal < 0 ? args[++i] : argument.slice(equal + 1); if (value && !/[\x00\r\n]/.test(value) && (equal >= 0 || !value.startsWith("-"))) { result.push(`${flag}=${value}`); continue; } }
    throw new Error(`Invalid Node runtime.args at index ${i}: use a supported runtime option; application arguments belong in args`);
  }
  return result;
}
