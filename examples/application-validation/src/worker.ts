import { content, pool } from "./common";
await content();
await pool.query("INSERT INTO acceptance VALUES ('worker', 'processed') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
await pool.end();
console.log("worker-complete");
