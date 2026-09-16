import { canonicalJSON, sha256 } from "../oci/digest.ts";
import type { Project } from "./config.ts";

/** Describe effective build policy without serializing define or runtime argument values. */
export function buildParameters(project: Project) {
  return {
    defineKeys: Object.keys(project.build.define).sort(),
    runtime: { ...(project.runtimeKind === "node" ? { kind: "node", nodeVersion: project.nodeVersion, versionVerified: false } : {}), libc: project.runtimeLibc, argumentCount: project.runtimeArgs.length, argumentsDigest: sha256(canonicalJSON(project.runtimeArgs)),
      path: project.bunPath, injection: project.runtimeInject, certificateCount: project.runtimeCAs.length, systemCaTrust: project.runtimeSystemCaTrust },
    assets: { excludes: [...project.assetExcludes], mode: project.assetMode },
  };
}
