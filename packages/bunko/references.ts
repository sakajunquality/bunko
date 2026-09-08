import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertFileAvailable } from "../oci/archive.ts";
import { canonicalOutput } from "../oci/layout.ts";

export async function referenceOutput(path: string | undefined, conflicts: (string | undefined)[] = []): Promise<string | undefined> {
  if (path === undefined) return;
  const output = await canonicalOutput(path);
  await assertFileAvailable(output, "Image references");
  for (const path of conflicts) if (path) {
    const other = await canonicalOutput(path);
    if (output === other || output.startsWith(`${other}/`) || other.startsWith(`${output}/`)) throw new Error("Image references must not overlap another output or cache path");
  }
  return output;
}

export async function writeReferences(path: string, references: string[]): Promise<void> {
  if (references.some((reference) => !/@sha256:[a-f0-9]{64}$/.test(reference) || /\s/.test(reference))) throw new Error("Image references must be immutable registry digests");
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".bunko-references-"));
  try {
    const file = join(temporary, "references.txt");
    await writeFile(file, [...new Set(references)].map((value) => value + "\n").join(""));
    await link(file, path);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function localImageReference(name: string, digest: string, kind?: string): string {
  return `${kind ? "kind.local" : "bunko.local"}/${name}:sha256-${digest.slice(7)}`;
}
