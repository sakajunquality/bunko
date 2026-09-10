import { redactInstallerOutput } from "../packages/bunko/install-diagnostics.ts";

/** Job summary rendering for the build Action.
 *
 * Reports are produced by a separately released CLI, so every field is treated as optional and
 * validated structurally here: an older or newer report must degrade to fewer lines, never to a
 * failed job. Rendering is a pure function so it is testable without a GitHub runner.
 *
 * Report strings are application-controlled and may be long, may contain Markdown syntax and may
 * quote credentials that a registry echoed back in an error, so every free-form value is redacted,
 * length-capped and escaped, row counts are bounded, and the rendered section is held to a byte
 * budget: GitHub rejects a step summary larger than 1 MiB outright.
 */

export const summaryHeading = "### bunko build";
/** Budget for one rendered section, below GitHub's 1 MiB limit for the whole step summary file. */
export const summaryBytes = 900 * 1024;
const fieldLimit = 200, sourceLimit = 1024, phaseLimit = 40, kindLimit = 20, targetLimit = 50, platformLimit = 20;
const truncated = "_Summary truncated to fit the job summary size limit._";

/** Registry errors quote request URLs; strip userinfo, query strings and header/token shapes with
 * the CLI's installer scrubbers, then mask credential-bearing query keys of schemeless URLs too. */
const credentialQuery = /([?&](?:token|access_token|sig|signature|key|password|secret|authorization)=)[^\s&#"'<>]+/gi;
const redact = (value: string) => redactInstallerOutput(value).replace(credentialQuery, "$1<redacted>");

/** Redact, flatten control and format characters, and cap the length of one report string.
 * The value is cut to `sourceLimit` before redaction because the scrubbers cost superlinear time in
 * the length of an unbroken token. Drop a token cut by the window before redacting:
 * its credential delimiter may occur beyond the window and must not expose its prefix. */
function clamp(value: string, limit = fieldLimit): string {
  const window = value.slice(0, sourceLimit);
  const source = value.length > sourceLimit ? window.replace(/\S+$/, "") : window;
  const flat = redact(source).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/ {2,}/g, " ").trim();
  const characters = [...flat];
  return characters.length > limit || value.length > source.length ? `${characters.slice(0, limit).join("")}…` : flat;
}

/** Escape a report string for prose, headings and table cells: Markdown structure characters are
 * backslash-escaped so links, images and emphasis cannot be injected, and the characters that would
 * break a table row or introduce markup are entity-encoded. */
export const escape = (value: string) => clamp(value)
  .replace(/[\\`*_[\]()#!~]/g, (character) => `\\${character}`)
  // `<`, `>`, `&` and `|` are entity-encoded rather than backslash-escaped: a backslash in front of
  // an entity would be rendered literally and break the encoding it is meant to protect.
  .replace(/[&<>|]/g, (character) => `&#${character.charCodeAt(0)};`);

/** References and digests read better verbatim; a code span makes their content inert, so it only
 * needs the backticks that would end the span removed. */
export const codeSpan = (value: string) => `\`${clamp(value).replaceAll("`", "")}\``;

/** One line instead of a section when the report is absent, oversized or unparsable. */
export const summaryNote = (reason: string) => `${summaryHeading}\n\n${escape(reason)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const seconds = (ms: number) => (ms / 1000).toFixed(1);
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const omitted = (total: number, limit: number, noun: string) => (total > limit ? [`- ${total - limit} more ${noun} omitted.`] : []);

interface Timing { phase: string; platform?: string; durationMs: number }
/** Only completed phases describe where time went; failed and in-flight entries are excluded. */
function completedTimings(target: Record<string, unknown>): Timing[] {
  return records(target.timings).flatMap((entry) => {
    const phase = text(entry.phase);
    return entry.status === "completed" && phase && typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
      ? [{ phase, platform: text(entry.platform), durationMs: entry.durationMs }] : [];
  });
}

function phaseTable(timings: Timing[]): string[] {
  if (!timings.length) return ["No completed phase timings in the report."];
  // A single platform keeps one row per phase; several platforms would otherwise hide which one is slow.
  const platforms = new Set(timings.map((timing) => timing.platform).filter((platform): platform is string => Boolean(platform)));
  const perPlatform = platforms.size > 1;
  const rows = new Map<string, { phase: string; platform: string; runs: number; durationMs: number }>();
  for (const timing of timings) {
    const platform = timing.platform ?? "all";
    const key = perPlatform ? `${timing.phase} on ${platform}` : timing.phase;
    const row = rows.get(key) ?? { phase: timing.phase, platform, runs: 0, durationMs: 0 };
    row.runs += 1; row.durationMs += timing.durationMs;
    rows.set(key, row);
  }
  const ordered = [...rows.values()].sort((a, b) => b.durationMs - a.durationMs || a.phase.localeCompare(b.phase));
  const header = perPlatform ? ["Phase", "Platform", "Runs", "Seconds"] : ["Phase", "Runs", "Seconds"];
  const alignment = perPlatform ? ["---", "---", "---:", "---:"] : ["---", "---:", "---:"];
  return [
    `| ${header.join(" | ")} |`,
    `| ${alignment.join(" | ")} |`,
    ...ordered.slice(0, phaseLimit).map((row) => `| ${[escape(row.phase), ...perPlatform ? [escape(row.platform)] : [], String(row.runs), seconds(row.durationMs)].join(" | ")} |`),
    ...ordered.length > phaseLimit ? ["", `${ordered.length - phaseLimit} more phase rows omitted.`] : [],
  ];
}

function cacheLine(target: Record<string, unknown>): string {
  const seen = new Set<string>();
  for (const event of records(target.cache)) {
    const kind = text(event.kind), status = text(event.status), reason = text(event.reason);
    if (kind && status) seen.add(`${escape(kind)}=${escape(status)}${reason ? ` (${escape(reason)})` : ""}`);
    if (seen.size >= kindLimit) break;
  }
  return `Cache: ${seen.size ? [...seen].join(", ") : "not reported"}`;
}

/** Descriptor sizes are stored layer bytes, not the expanded filesystem. */
function layerLine(layers: unknown, platform?: string): string | undefined {
  const sizes = new Map<string, number>();
  let total = 0;
  for (const layer of records(layers)) {
    const kind = text(layer.kind), size = isRecord(layer.descriptor) ? layer.descriptor.size : undefined;
    if (!kind || typeof size !== "number" || !Number.isFinite(size)) continue;
    sizes.set(kind, (sizes.get(kind) ?? 0) + size); total += size;
  }
  if (!sizes.size) return undefined;
  const listed = [...sizes].slice(0, kindLimit);
  const label = platform ? `Layers (${escape(platform)})` : "Layers";
  const rest = sizes.size > listed.length ? `, ${sizes.size - listed.length} more kinds` : "";
  return `${label}: ${listed.map(([kind, size]) => `${escape(kind)} ${megabytes(size)}`).join(", ")}${rest} (${megabytes(total)} stored)`;
}

function layerLines(target: Record<string, unknown>): string[] {
  const images = records(target.images);
  // Multi-platform builds report one layer set per platform; the top-level list only describes the first.
  if (images.length > 1) return images.slice(0, platformLimit).flatMap((image) => {
    const platform = isRecord(image.platform) ? `${text(image.platform.os) ?? "?"}/${text(image.platform.architecture) ?? "?"}` : text(image.platform);
    const line = layerLine(image.layers, platform);
    return line ? [line] : [];
  });
  const line = layerLine(target.layers ?? images[0]?.layers);
  return line ? [line] : [];
}

function publishLines(target: Record<string, unknown>): string[] {
  const publication = target.publication;
  if (!isRecord(publication)) return [];
  const lines: string[] = [];
  const transfers = records(publication.transfers);
  const blobs = isRecord(publication.blobs) ? publication.blobs
    : { reused: transfers.filter((t) => t.action === "reused").length, mounted: transfers.filter((t) => t.action === "mounted").length, uploaded: transfers.filter((t) => t.action === "uploaded").length };
  const parts = [`blobs ${count(blobs.reused)} reused, ${count(blobs.mounted)} mounted, ${count(blobs.uploaded)} uploaded`];
  if (transfers.length) parts.push(`${megabytes(transfers.reduce((total, transfer) => total + count(transfer.uploaded), 0))} uploaded`);
  if (typeof publication.elapsedMs === "number" && Number.isFinite(publication.elapsedMs)) parts.push(`${Math.round(publication.elapsedMs)} ms`);
  lines.push(`Publish: ${parts.join("; ")}`);
  const reference = text(publication.reference);
  if (publication.published && reference) lines.push(`Published: ${codeSpan(reference)}`);
  return lines;
}

function targetSection(target: Record<string, unknown>, heading: boolean): string[] {
  const name = text(target.target) ?? "unnamed target";
  const lines = heading ? [`#### ${escape(name)}`, ""] : [];
  lines.push(...phaseTable(completedTimings(target)), "");
  // A list keeps each fact on its own rendered line regardless of how the host wraps soft breaks.
  lines.push(...[cacheLine(target), ...layerLines(target), ...publishLines(target)].map((line) => `- ${line}`));
  return lines;
}

/** Keep whole lines while they fit the byte budget; the notice itself is always affordable. */
export function fitSummary(lines: string[], limit: number): string {
  const notice = Buffer.byteLength(`${truncated}\n`);
  if (limit < notice) return "";
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(`${line}\n`);
    if (used + size > Math.max(limit - notice, 0)) { kept.push(truncated); break; }
    kept.push(line); used += size;
  }
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Render the whole job summary section for one build report; never throws for malformed input.
 * `limit` is the byte budget left for this section in the step summary file. */
export function renderSummary(report: unknown, limit = summaryBytes): string {
  if (!isRecord(report)) return fitSummary(summaryNote("The build report was not a JSON object; no summary is available.").split("\n"), limit);
  const all = Array.isArray(report.targets) ? records(report.targets) : [report];
  const targets = all.slice(0, targetLimit);
  const version = targets.flatMap((target) => (isRecord(target.builder) ? [text(target.builder.version)] : [])).find(Boolean);
  const described = targets.map((target) => {
    const platform = text(target.platform);
    return `${escape(text(target.target) ?? "unnamed target")}${platform ? ` (${escape(platform)})` : ""}`;
  });
  const lines = [summaryHeading, "", `bunko ${version ? escape(version) : "(version not reported)"} — ${described.length ? described.join(", ") : "no target results"}`, ""];
  if (report.status === "failed") {
    lines.push(`Build failed: ${escape(text(report.error) ?? "no error message in the report")}`, "");
    const pending = Array.isArray(report.pendingTargets) ? report.pendingTargets.filter((value): value is string => typeof value === "string") : [];
    if (pending.length) lines.push(`Targets not built: ${pending.slice(0, targetLimit).map(escape).join(", ")}`, "");
  }
  for (const target of targets) lines.push(...targetSection(target, targets.length > 1), "");
  lines.push(...omitted(all.length, targetLimit, "targets"));
  return fitSummary(lines, limit);
}
