import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import isNumber from "is-number";

const index = readFileSync(new URL("./public/index.html", import.meta.url));
const port = Number(process.env.PORT ?? 3000);

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, numberCheck: isNumber(42) }));
  } else if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(index);
  } else {
    response.writeHead(404);
    response.end("Not found\n");
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Listening on ${port}`));
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
