import { object } from "../oci/digest.ts";

/** An allowance accepts shipped files; it never authorizes running a hook. */
export function ignoredInstallScripts(pkg: Record<string, unknown>, allowed: string[] = []): string[] {
  const scripts = object(pkg.scripts ?? {}, "Runtime scripts");
  const hooks = ["preinstall", "install", "postinstall"].filter((key) => scripts[key]);
  if (hooks.length && (typeof pkg.name !== "string" || !allowed.includes(pkg.name))) throw new Error(installScriptsMessage(pkg, hooks));
  return hooks;
}

/** Name the package, version and hooks, state the policy once, and show the exact allowance to write. */
function installScriptsMessage(pkg: Record<string, unknown>, hooks: string[]): string {
  const name = typeof pkg.name === "string" ? pkg.name : undefined, version = typeof pkg.version === "string" ? pkg.version : undefined;
  const label = name === undefined ? "<unnamed>" : version === undefined ? name : `${name}@${version}`;
  const allowance = name === undefined ? "The package has no name, so it cannot be allowed." : `If the published files work without them, allow the package explicitly in the target's package.json:\n  "bunko": { "deps": { "allowIgnoredScripts": [${JSON.stringify(name)}] } }`;
  return `Runtime package ${label} declares install scripts (${hooks.join(", ")}). Bunko never runs install hooks. ${allowance}\nOtherwise use prepared dependency artifacts (docs/OPERATIONS.md) or an external base that provides the package.`;
}
