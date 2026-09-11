import { inactiveLibcVariants } from "./native-variants.ts";
import { posix } from "node:path";
import { baseNode, type BaseFilesystem } from "./runtime-layer.ts";
import type { NativeBinary } from "./deps.ts";

/** Static filesystem evidence only: presence does not establish loader search, ABI or trust. */
export function baseCapabilities(tree: BaseFilesystem, config: { Env?: string[]; User?: string; WorkingDir?: string }, workdir = config.WorkingDir || "/", native: NativeBinary[] = []) {
  const env = Object.fromEntries((config.Env ?? []).filter((value) => value.includes("=")).map((value) => { const split = value.indexOf("="); return [value.slice(0, split), value.slice(split + 1)]; }));
  const unresolvedPaths = new Set<string>();
  const nodeAt = (path: string) => { try { return baseNode(tree, path); } catch { unresolvedPaths.add(path); return undefined; } };
  const file = (path: string) => { const node = nodeAt(path); return node?.type === "file" && node.size > 0; };
  const paths = [...tree.keys()].sort();
  // baseFilesystem creates distinct nodes for explicit and implied directories; baseNode returns those exact nodes.
  const directoryPath = (path: string) => {
    if (path === "/") return "";
    const node = nodeAt(path);
    return node?.type === "directory" ? paths.find((candidate) => tree.get(candidate) === node) : undefined;
  };
  const configuredFile = env.SSL_CERT_FILE, configuredDirectory = env.SSL_CERT_DIR;
  const caFiles = [...new Set(["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem", ...(configuredFile?.startsWith("/") ? [configuredFile] : [])])].filter(file);
  const caDirectories = [...new Set(["/etc/ssl/certs", "/etc/pki/tls/certs", ...(configuredDirectory ?? "").split(":").filter((path) => path.startsWith("/")).map((path) => posix.normalize(path).replace(/\/$/, "") || "/")])]
    .filter((directory) => { const prefix = directoryPath(directory); return prefix !== undefined && paths.some((path) => posix.dirname(path) === (prefix || ".") && /(?:\.(?:crt|pem)|\.[0-9]+)$/.test(path) && file("/" + path)); });
  const fonts = paths.filter((path) => /(?:^|\/)fonts\//.test(path) && /\.(?:ttf|otf|ttc|otc|pcf|pfa|pfb)(?:\.gz)?$/i.test(path) && file("/" + path));
  const libraries = new Map<string, string[]>();
  for (const path of paths) if (/\.so(?:\.|$)/.test(posix.basename(path)) && !["ld.so.conf", "ld.so.cache", "ld.so.preload"].includes(posix.basename(path)) && file("/" + path)) {
    const name = posix.basename(path); libraries.set(name, [...(libraries.get(name) ?? []), "/" + path]);
  }
  const executableLoaders = new Set([...libraries].filter(([, paths]) => paths.some((path) => Boolean((nodeAt(path)?.mode ?? 0) & 0o111))).map(([name]) => name));
  const inactive = inactiveLibcVariants(native, executableLoaders);
  const requirements = native.flatMap((binary) => binary.needed.map((name) => {
    const candidates = name.startsWith("/") ? file(name) ? [name] : [] : name.includes("/") ? [] : libraries.get(name) ?? [];
    return { name, requiredBy: binary.path, candidates, status: inactive.has(binary.path) ? "inactive-libc-variant" : candidates.length ? "present" : (name.includes("/") && !name.startsWith("/")) || [...unresolvedPaths].some((path) => (name.startsWith("/") ? path === name : posix.basename(path) === name)) ? "unknown" : "missing-from-base" };
  }));
  const directory = workdir === "/" ? undefined : nodeAt(workdir);
  const prefix = directoryPath(workdir) ?? workdir.replace(/^\/+|\/+$/g, "");
  return {
    inspection: "static" as const, runtimeCompatibilityVerified: false,
    ca: { files: caFiles, directories: caDirectories, systemStorePresent: Boolean(caFiles.length || caDirectories.length), configuredFile, configuredDirectory },
    fonts: { count: fonts.length, files: fonts.slice(0, 100).map((path) => "/" + path), truncated: fonts.length > 100, fontconfig: ["/etc/fonts/fonts.conf", "/usr/local/etc/fonts/fonts.conf"].filter(file) },
    shells: ["/bin/sh", "/bin/bash", "/bin/ash", "/usr/bin/sh"].filter((path) => { const node = nodeAt(path); return node?.type === "file" && Boolean(node.mode & 0o111); }),
    user: config.User ?? "", workdir: { path: workdir, type: workdir === "/" ? "directory" : directory?.type ?? "absent", empty: unresolvedPaths.has(workdir) ? undefined : !paths.some((path) => !prefix || path.startsWith(prefix + "/")) },
    sharedLibraryCount: libraries.size, sharedLibrariesTruncated: libraries.size > 1000,
    sharedLibraries: [...libraries].slice(0, 1000).map(([name, paths]) => ({ name, paths: paths.slice(0, 100), truncated: paths.length > 100 })), requirements,
    unresolvedPaths: [...unresolvedPaths].sort(),
    inactiveNativeVariants: [...inactive.values()],
    missingFromBase: requirements.filter((item) => item.status === "missing-from-base"),
    unchecked: ["dynamic loader search paths, ELF architecture, ABI and symbol versions", "libraries supplied by application layers", "certificate trust contents and font family/glyph coverage"],
  };
}
