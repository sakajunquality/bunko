// GitHub Actions cache integration for the build Action.
// The composite Action runs this before the build to validate the `cache` input, resolve which directories
// belong to the managed bunko cache and compute the restore/save key that actions/cache uses.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { list } from "./inputs.ts";

export type CacheMode = "none" | "github";
export interface CacheKeyInputs {
  key?: string;
  restoreKeys?: string;
  os?: string;
  arch?: string;
  version?: string;
  hash?: string;
  targets?: string;
}
export interface CachePlanInputs extends CacheKeyInputs {
  cache?: string;
  cacheDir?: string;
  installCache?: string;
  root: string;
}
export interface CachePlan { enabled: boolean; paths: string[]; key: string; restoreKeys: string[] }

const SEGMENT = /^[A-Za-z0-9._+-]+$/;

/**
 * Managed cache root; the CLI keeps layers, closure plans, package downloads and asset caches underneath it.
 * The fallback mirrors the CLI exactly, including `??`: an empty `XDG_CACHE_HOME` yields the relative `bunko`
 * the CLI would use, not the home directory, so the persisted directory is the one the build actually writes.
 */
export const managedCacheRoot = (environment: Record<string, string | undefined> = process.env, home = homedir()): string =>
  join(environment.XDG_CACHE_HOME ?? join(home, ".cache"), "bunko");

/**
 * Layer cache directory the CLI will use: the Action input wins, then `BUNKO_CACHE_DIR`, then the managed root.
 * run.ts forwards `--cache-dir` only for a non-empty input, so an empty input leaves the environment in charge.
 */
export const resolvedCacheDir = (input?: string, environment: Record<string, string | undefined> = process.env): string | undefined =>
  (input ?? "").trim() || environment.BUNKO_CACHE_DIR;

/** GITHUB_OUTPUT heredoc delimiter that cannot appear as a line of any value it has to carry. */
export function outputDelimiter(values: string[]): string {
  let delimiter = "BUNKO_CACHE_OUTPUT_EOF";
  while (values.some((value) => value.split(/\r?\n/).includes(delimiter))) delimiter = `BUNKO_CACHE_OUTPUT_EOF_${crypto.randomUUID().replaceAll("-", "")}`;
  return delimiter;
}

export function cacheMode(value: string | undefined): CacheMode {
  const mode = (value ?? "").trim();
  if (mode === "" || mode === "none") return "none";
  if (mode === "github") return "github";
  throw new Error(`Unsupported build Action cache input ${JSON.stringify(mode)}; use github or none`);
}

/**
 * Directories handed to actions/cache. The managed root always participates because the package download,
 * asset and runtime caches stay there even when `cache-dir` moves the layer cache elsewhere; explicit
 * directories outside the root are added, and directories inside it are already covered.
 */
export function cachePaths(root: string, cacheDir?: string, installCache?: string): string[] {
  const paths: string[] = [];
  for (const candidate of [root, cacheDir, installCache]) {
    const value = (candidate ?? "").trim();
    if (!value) continue;
    const path = resolve(value);
    if (/[\r\n]/.test(path)) throw new Error("Cached bunko directories cannot contain line breaks");
    if (paths.some((kept) => path === kept || path.startsWith(`${kept}${sep}`))) continue;
    paths.push(path);
  }
  if (!paths.length) throw new Error("The build Action cache needs at least one directory to persist");
  return paths;
}

const segment = (value: string | undefined, name: string): string => {
  const trimmed = (value ?? "").trim();
  if (!SEGMENT.test(trimmed)) throw new Error(`The build Action cache key ${name} must be a non-empty [A-Za-z0-9._+-] value`);
  return trimmed;
};

const validate = (key: string, name: string): string => {
  // GitHub rejects cache keys longer than 512 characters and keys containing a comma.
  if (!key || /[\s,]/.test(key) || key.length > 512) throw new Error(`Invalid build Action ${name}; use at most 512 characters without commas or whitespace`);
  return key;
};

/**
 * Cache-key segment for the selected targets, parsed exactly as the build step parses `targets`.
 * `all` stands for an unfiltered build, so the common single-project workflow keeps one stable key;
 * any selection becomes a short digest of its sorted, de-duplicated members, which makes the segment
 * independent of the order and repetition the workflow happened to write and safe in a key and a path.
 * Two workflows building different targets of one workspace share a lockfile hash, so without this
 * segment they would compute the same key, race to reserve it and leave the loser saving nothing.
 * Truncating to 48 bits makes two selections sharing a segment unlikely, not impossible; `cache-key`
 * is the way to separate entries with certainty.
 */
export function targetsSegment(targets?: string): string {
  const selected = [...new Set(list(targets))].sort();
  return selected.length ? new Bun.CryptoHasher("sha256").update(selected.join("\n")).digest("hex").slice(0, 12) : "all";
}

/** Default key `bunko-<os>-<arch>-<version>-<targets>-<hash>` with the hashless prefix as the single restore key. */
export function cacheKeys(inputs: CacheKeyInputs): { key: string; restoreKeys: string[] } {
  const explicit = (inputs.key ?? "").trim(), overrides = list(inputs.restoreKeys);
  // The targets segment sits inside the restore prefix as well, so a prefix match restores only a
  // cache written for the same operating system, architecture, CLI version and targets segment.
  const prefix = `bunko-${segment(inputs.os, "operating system")}-${segment(inputs.arch, "architecture")}-${segment(inputs.version, "bunko version")}-${targetsSegment(inputs.targets)}-`;
  // An empty hash means no lockfile or manifest matched the pattern; keep the key distinguishable from the prefix.
  const key = validate(explicit || `${prefix}${segment(inputs.hash || "nofiles", "input hash")}`, "cache-key");
  const restoreKeys = (overrides.length ? overrides : explicit ? [] : [prefix]).map((value) => validate(value, "cache-restore-keys"));
  return { key, restoreKeys };
}

export function cachePlan(inputs: CachePlanInputs): CachePlan {
  if (cacheMode(inputs.cache) === "none") return { enabled: false, paths: [], key: "", restoreKeys: [] };
  return { enabled: true, paths: cachePaths(inputs.root, inputs.cacheDir, inputs.installCache), ...cacheKeys(inputs) };
}

export const cacheOutputs = (plan: CachePlan): Record<string, string> => ({ enabled: String(plan.enabled), path: plan.paths.join("\n"), key: plan.key, "restore-keys": plan.restoreKeys.join("\n") });

export function formatOutputs(outputs: Record<string, string>): string {
  const delimiter = outputDelimiter(Object.values(outputs));
  return Object.entries(outputs).map(([name, value]) => (value.includes("\n") ? `${name}<<${delimiter}\n${value}\n${delimiter}\n` : `${name}=${value}\n`)).join("");
}

/** Installed CLI version, used so a CLI upgrade cannot reuse caches written by another release. */
export async function installedVersion(): Promise<string> {
  const executable = Bun.which("bunko", { PATH: process.env.PATH });
  if (!executable) throw new Error("Install bunko with the setup Action before the build Action");
  const child = Bun.spawn([executable, "version"], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const printed = await new Response(child.stdout).text();
  if ((await child.exited) !== 0 || child.signalCode) throw new Error("Could not read the installed bunko version for the cache key");
  return list(printed).at(-1) ?? "";
}

export async function runCachePlan(inputs: Omit<CachePlanInputs, "root" | "version">): Promise<CachePlan> {
  const enabled = cacheMode(inputs.cache) === "github";
  const plan = enabled
    ? cachePlan({ ...inputs, cacheDir: resolvedCacheDir(inputs.cacheDir), root: managedCacheRoot(), version: await installedVersion() })
    : { enabled: false, paths: [], key: "", restoreKeys: [] };
  // actions/cache fails when none of its paths exist, and a first run has no managed cache yet.
  for (const path of plan.paths) await mkdir(path, { recursive: true });
  if (plan.enabled) console.log(`bunko cache: mode=github key=${plan.key} paths=${plan.paths.join(", ")}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, formatOutputs(cacheOutputs(plan)));
  return plan;
}

if (import.meta.main) {
  await runCachePlan({
    cache: process.env.BUNKO_CACHE_MODE,
    cacheDir: process.env.BUNKO_CACHE_DIR_INPUT,
    installCache: process.env.BUNKO_CACHE_INSTALL_INPUT,
    key: process.env.BUNKO_CACHE_KEY_INPUT,
    restoreKeys: process.env.BUNKO_CACHE_RESTORE_KEYS_INPUT,
    os: process.env.BUNKO_CACHE_OS,
    arch: process.env.BUNKO_CACHE_ARCH,
    hash: process.env.BUNKO_CACHE_HASH,
    targets: process.env.BUNKO_CACHE_TARGETS,
  });
}
