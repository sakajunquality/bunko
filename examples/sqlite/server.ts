import { Database } from "bun:sqlite";

const database = new Database(process.env.DB_PATH ?? "/tmp/bunko.sqlite", { create: true });
database.run("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY)");
Bun.serve({ port: 3000, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return new Response("ok");
  if (path !== "/visits") return new Response("Not found", { status: 404 });
  if (request.method === "POST") database.run("INSERT INTO visits DEFAULT VALUES");
  else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  return Response.json(database.query("SELECT COUNT(*) AS count FROM visits").get());
} });
