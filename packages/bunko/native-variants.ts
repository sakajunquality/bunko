import type { NativeBinary } from "./deps.ts";

type Libc = "glibc" | "musl";
const loaders: Record<string, Record<Libc, string>> = {
  amd64: { glibc: "ld-linux-x86-64.so.2", musl: "ld-musl-x86_64.so.1" },
  arm64: { glibc: "ld-linux-aarch64.so.1", musl: "ld-musl-aarch64.so.1" },
};

/** Recognize a paired Linux addon by both its variant-labelled path and ELF dependencies. */
function variant(binary: NativeBinary): { libc: Libc; key: string } | undefined {
  if (!binary.path.endsWith(".node")) return;
  const cpu = binary.architecture === "amd64" ? "(?:x64|amd64)" : binary.architecture === "arm64" ? "arm64" : undefined;
  if (!cpu || !new RegExp(`linux[.-]${cpu}[.-](?:gnu|glibc|musl)(?=[@./]|$)`).test(binary.path)) return;
  const glibc = binary.needed.includes("libc.so.6"), musl = binary.needed.includes("libc.so");
  if (glibc === musl) return;
  const libc: Libc = glibc ? "glibc" : "musl";
  const labels = [...binary.path.matchAll(/[.-](gnu|glibc|musl)(?=[@./]|$)/g)].map((match) => match[1] === "musl" ? "musl" : "glibc");
  if (!labels.length || labels.some((label) => label !== libc)) return;
  return { libc, key: `${binary.architecture}:${binary.path.replace(/([.-])(?:gnu|glibc|musl)(?=[@./]|$)/g, "$1libc")}` };
}

/** Advisory selection only: preserve every binary and requirement, and never infer runtime ABI compatibility. */
export function inactiveLibcVariants(native: NativeBinary[], executableLoaders: ReadonlySet<string>) {
  const variants = native.map((binary) => ({ binary, variant: variant(binary) }));
  const pairs = new Map<string, NativeBinary>();
  for (const item of variants) if (item.variant) pairs.set(`${item.variant.key}:${item.variant.libc}`, item.binary);
  const inactive = new Map<string, { path: string; libc: Libc; baseLibc: Libc; alternative: string }>();
  for (const { binary, variant } of variants) {
    const names = loaders[binary.architecture];
    if (!variant || !names) continue;
    const glibc = executableLoaders.has(names.glibc), musl = executableLoaders.has(names.musl);
    if (glibc === musl) continue;
    const baseLibc: Libc = glibc ? "glibc" : "musl";
    const alternative = pairs.get(`${variant.key}:${baseLibc}`);
    if (variant.libc !== baseLibc && alternative) inactive.set(binary.path, { path: binary.path, libc: variant.libc, baseLibc, alternative: alternative.path });
  }
  return inactive;
}
