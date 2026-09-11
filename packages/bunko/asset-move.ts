import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Move a private extracted file without exposing a partial copy in the destination filesystem. */
export async function moveAssetFile(source: string, destination: string): Promise<void> {
  try { await rename(source, destination); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  const temporary = join(dirname(destination), `.asset-${randomUUID()}`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await rename(temporary, destination);
    await unlink(source);
  } finally { await rm(temporary, { force: true }); }
}
