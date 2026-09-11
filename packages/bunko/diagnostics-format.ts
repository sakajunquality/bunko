import { contextMapping, imageMapping } from "./asset-contexts.ts";
import type { DiagnosticTarget, checkConfig, doctor } from "./diagnostics.ts";
import type { Platform } from "../oci/types.ts";

export type ConfigReport = Awaited<ReturnType<typeof checkConfig>>;
export type DoctorReport = Awaited<ReturnType<typeof doctor>>;
export type DiagnosticsReport = ConfigReport | DoctorReport;

const DOT = " · ";
const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join(DOT) || undefined;
const list = (items: readonly (string | number)[]) => items.length ? items.join(", ") : undefined;
const count = (value: number, singular: string) => value ? `${value} ${singular}${value === 1 ? "" : "s"}` : undefined;
const octal = (mode: number) => `0${mode.toString(8).padStart(3, "0")}`;
const platforms = (items: Platform[]) => items.map((item) => `${item.os}/${item.architecture}${item.variant ? `/${item.variant}` : ""}`).join(", ");

interface Row { label: string; keys: (keyof DiagnosticTarget)[]; value: (target: DiagnosticTarget) => string | undefined }

/** Every row consumes the target keys it renders, so a new diagnostic field cannot be dropped unnoticed. */
const rows: Row[] = [
  { label: "Entrypoint", keys: ["entrypoint", "mode"], value: (target) => `${target.entrypoint}${DOT}${target.mode} mode` },
  { label: "Entrypoints", keys: ["entrypoints", "defaultEntrypoint"], value: (target) => join([
    target.entrypoints && Object.entries(target.entrypoints).map(([name, source]) => `${name} = ${source}`).join(", "),
    target.defaultEntrypoint && `default ${target.defaultEntrypoint}`]) },
  { label: "Platforms", keys: ["platforms"], value: (target) => platforms(target.platforms) },
  { label: "Base", keys: ["base"], value: (target) => target.base },
  { label: "Dependencies", keys: ["dependencyStrategy", "lockfileVersion"], value: (target) => join([target.dependencyStrategy, target.lockfileVersion === undefined ? "no lockfile" : `bun.lock version ${target.lockfileVersion}`]) },
  { label: "External", keys: ["external"], value: (target) => list(target.external) },
  { label: "Assets", keys: ["assets", "assetExcludes", "assetMode", "explicitAssetsOverrideGitignore"], value: (target) => join([
    list(target.assets), target.explicitAssetsOverrideGitignore ? "explicit assets override .gitignore" : undefined, target.assetExcludes.length ? `excludes ${target.assetExcludes.join(", ")}` : undefined,
    target.assetMode === undefined ? undefined : `mode ${octal(target.assetMode)}`]) },
  { label: "Asset mappings", keys: ["assetMappings", "assetInputs"], value: (target) => target.assetMappings.length ? [
    ...target.assetMappings.map((mapping) => `${contextMapping(mapping) ? `${mapping.context}:${mapping.from}` : imageMapping(mapping) ? `${mapping.image}:${mapping.from}${mapping.platform ? ` [${mapping.platform}]` : ""}` : `${mapping.url} [sha256:${mapping.sha256}]`} → ${mapping.to}${mapping.mode ? ` (${mapping.mode})` : ""}${contextMapping(mapping) && mapping.exclude?.length ? ` excludes ${mapping.exclude.join(", ")}` : ""}`),
    `${target.assetInputs.entries} selected entr${target.assetInputs.entries === 1 ? "y" : "ies"} in ${target.assetInputs.contexts.join(", ") || "local contexts"}`,
    ...target.assetInputs.external ? [`${target.assetInputs.external} external source(s); content not checked offline`] : []].join("\n") : undefined },
  { label: "Environment", keys: ["environmentKeys"], value: (target) => list(target.environmentKeys) },
  { label: "Defines", keys: ["defineKeys"], value: (target) => list(target.defineKeys) },
  { label: "User", keys: ["user"], value: (target) => target.user },
  { label: "Workdir", keys: ["workdir"], value: (target) => target.workdir },
  { label: "Ports", keys: ["ports"], value: (target) => target.ports && list(target.ports) },
  { label: "Runtime", keys: ["runtimeLibc", "runtimePath", "runtimeInjection", "runtimeArgumentCount", "runtimeCertificateCount", "runtimeSystemCaTrust"], value: (target) => join([
    target.runtimePath, target.runtimeLibc, target.runtimeInjection && `injected ${target.runtimeInjection}`,
    count(target.runtimeArgumentCount, "runtime argument"), count(target.runtimeCertificateCount, "CA certificate"), target.runtimeSystemCaTrust ? "native CA trust (SSL_CERT_FILE)" : undefined]) },
  { label: "Toolchain", keys: ["toolchainRequirements"], value: (target) => {
    const required = target.toolchainRequirements;
    return [...required.version ? [`version ${required.version} (${required.versionSource ?? "unknown source"})`] : [],
      ...required.revision ? [`revision ${required.revision}`] : [],
      ...required.ranges.map((range, index) => `range ${range} (${required.rangeSources?.[index] ?? "unknown source"})`)].join("\n") || "none declared";
  } },
  { label: "Inherited defaults", keys: ["inheritedDefaults"], value: (target) => list(target.inheritedDefaults) },
  { label: "Warnings", keys: ["unmatchedAllowances"], value: (target) => target.unmatchedAllowances.length ? `ignored-script allowances matching no locked package: ${target.unmatchedAllowances.join(", ")}` : undefined },
];

/** Target keys the text summary renders; the diagnostics test rejects unlisted ones. */
export const renderedTargetKeys: string[] = [...new Set(["name", "path", ...rows.flatMap((row) => row.keys as string[])])];

interface Section { heading: string; entries: { label: string; value: string }[] }

/** Human summary of the same object the JSON output serializes, so the two never diverge. */
export function renderDiagnostics(report: DiagnosticsReport): string {
  const health = "toolchain" in report ? report : undefined;
  const sections: Section[] = [];
  if (health) sections.push({ heading: "Toolchain", entries: [
    { label: "Selected", value: `${health.toolchain.version}+${health.toolchain.revision}${DOT}${health.toolchain.path}` },
    { label: "Declared", value: [...new Set(report.targets.map((target) => target.toolchainRequirements.version && `${target.toolchainRequirements.version} (${target.toolchainRequirements.versionSource ?? "unknown source"})`).filter(Boolean))].join(", ") || "no version declaration" },
    { label: "Host", value: `${health.host.os}/${health.host.architecture}${DOT}Bun ${health.host.runtime}` },
    { label: "Optional tools", value: Object.entries(health.optionalTools).map(([name, present]) => `${name} ${present ? "yes" : "no"}`).join(DOT) },
  ] });
  for (const target of report.targets) sections.push({
    heading: `${target.name} (${target.path})`,
    entries: rows.flatMap((row) => { const value = row.value(target); return value === undefined ? [] : [{ label: row.label, value }]; }),
  });
  const width = Math.max(0, ...sections.flatMap((section) => section.entries.map((entry) => entry.label.length)));
  const lines = [`bunko ${report.bunko}${DOT}${health ? "doctor" : "check-config"}${DOT}${report.status}${DOT}${report.workspace ? "workspace" : "single project"}`];
  for (const section of sections) {
    lines.push("", section.heading);
    for (const entry of section.entries) lines.push(...entry.value.split("\n").map((line, index) => `  ${(index ? "" : entry.label).padEnd(width)}  ${line}`));
  }
  lines.push("", `Not checked offline (${report.unchecked.length} categories):`, ...report.unchecked.map((item) => `  - ${item}`));
  if (health) lines.push("", "Next steps:", ...health.advice.map((item) => `  - ${item}`));
  // Configuration and filesystem names can contain terminal control characters.
  return `${lines.join("\n")}\n`.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Text for a terminal reader, JSON for scripts; an explicit --format wins either way. */
export function diagnosticsFormat(requested: string | undefined, tty: boolean): "json" | "text" {
  if (requested !== undefined && requested !== "json" && requested !== "text") throw new Error("--format must be json or text");
  return requested ?? (tty ? "text" : "json");
}

export function diagnosticsOutput(report: DiagnosticsReport, format: "json" | "text"): string {
  return format === "text" ? renderDiagnostics(report) : `${JSON.stringify(report)}\n`;
}
