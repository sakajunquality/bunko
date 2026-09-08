import { object } from "../oci/digest.ts";

/** An allowance accepts shipped files; it never authorizes running a hook. */
export function ignoredInstallScripts(pkg: Record<string, unknown>, allowed: string[] = []): string[] {
  const scripts = object(pkg.scripts ?? {}, "Runtime scripts");
  const hooks = ["preinstall", "install", "postinstall"].filter((key) => scripts[key]);
  if (hooks.length && (typeof pkg.name !== "string" || !allowed.includes(pkg.name))) throw new Error(`Runtime package ${pkg.name} declares install scripts; ready-to-run files or an explicit deps.allowIgnoredScripts allowance are required`);
  return hooks;
}
