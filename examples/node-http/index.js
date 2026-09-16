import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const message = (await readFile(join(process.env.BUNKO_DATA_PATH || "bunkodata", "message.txt"), "utf8")).trim();
const selfTest = process.argv.includes("--self-test");
const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ message, runtime: process.release.name, uid: process.getuid() })); });
await new Promise((resolve) => server.listen(selfTest ? 0 : 3000, "0.0.0.0", resolve));
if (selfTest) {
  try {
    const result = await (await fetch(`http://127.0.0.1:${server.address().port}`)).json();
    if (result.message !== "Hello from Node" || result.runtime !== "node" || result.uid !== 65532) throw new Error("Unexpected runtime acceptance result");
    console.log(JSON.stringify(result));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
} else console.log("Listening on port 3000");
