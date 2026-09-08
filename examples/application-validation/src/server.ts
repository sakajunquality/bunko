import { Hono } from "hono";
import { content, pool } from "./common";
const app = new Hono();
app.get("/", () => new Response(Bun.file("public/index.html"), {headers:{"content-type":"text/html"}}));
app.get("/assets/app.js", () => new Response(Bun.file("public/app.js"), {headers:{"content-type":"text/javascript"}}));
app.get("/api/acceptance", async (c) => {
  const result = await pool.query("SELECT value FROM acceptance WHERE key = 'migration'");
  return c.json({ ...await content(), migration: result.rows[0]?.value });
});
app.get("/api/drain", async (c) => {
  await Bun.write("/tmp/drain-started", "ready");
  await Bun.sleep(750);
  const result = await pool.query("SELECT value FROM acceptance WHERE key = 'migration'");
  return c.json({ drained: result.rows[0]?.value === "applied" });
});
const server = Bun.serve({ port: 3000, fetch: app.fetch });
process.on("SIGTERM", async () => { await server.stop(); await pool.end(); process.exit(0); });
