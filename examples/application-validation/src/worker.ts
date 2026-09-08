import { content, pool } from "./common";
try {
  await content();
  await pool.query("INSERT INTO acceptance VALUES ('worker', 'processed') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  console.log("worker-complete");
} finally { await pool.end(); }
