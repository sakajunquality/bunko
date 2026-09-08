import pg from "pg";
import { xxh32 } from "@node-rs/xxhash";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export async function content() {
  const settings = await Bun.file("/repo/settings.json").json();
  const prompt = await Bun.file(`${process.cwd()}/data/prompt.md`).text();
  if (settings.message !== "configured-content" || prompt !== "Expected application prompt.\n") throw new Error("Required runtime content is missing");
  return { settings: settings.message, prompt, hash: xxh32("bunko") };
}
