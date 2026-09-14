import lazy from "@acceptance/lazy";
import { catalog } from "./lib/catalog";

const server = Bun.serve({
  port: 3000,
  fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/health": return Response.json({ ready: true });
      case "/catalog": return Response.json({ ids: catalog() });
      case "/dependency":
        try { return Response.json({ value: lazy.run() }); }
        catch { return Response.json({ error: "DEPENDENCY_UNAVAILABLE" }, { status: 500 }); }
      default: return new Response("Not found", { status: 404 });
    }
  },
});
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
