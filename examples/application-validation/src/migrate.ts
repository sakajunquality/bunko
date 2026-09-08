import { content, pool } from "./common";
await content();
await pool.query("CREATE TABLE IF NOT EXISTS acceptance (key text PRIMARY KEY, value text NOT NULL)");
await pool.query("INSERT INTO acceptance VALUES ('migration', 'applied') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
await pool.end();
console.log("migration-complete");
