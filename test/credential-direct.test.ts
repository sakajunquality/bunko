import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("compiled callers use an actual Bun worker and bypass ambient proxies", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-direct-test-"));
  let requests = 0, proxied = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("credential-result"); } });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxied++; return new Response("unexpected proxy", { status: 500 }); } });
  try {
    const entry = join(root, "entry.ts"), executable = join(root, "client");
    await writeFile(entry, `import { credentialRequest } from ${JSON.stringify(new URL("../packages/oci/credential-http.ts", import.meta.url).pathname)}; console.log((await credentialRequest('test', ${JSON.stringify(server.url.href)}, {})).text);`);
    const compile = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", executable], { stdout: "pipe", stderr: "pipe" });
    const [, errors, code] = await Promise.all([new Response(compile.stdout).text(), new Response(compile.stderr).text(), compile.exited]);
    expect(code, errors).toBe(0);
    const child = Bun.spawn([executable], { env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HTTP_PROXY: proxy.url.href, HTTPS_PROXY: proxy.url.href, ALL_PROXY: proxy.url.href, NO_PROXY: "", http_proxy: proxy.url.href, https_proxy: proxy.url.href, all_proxy: proxy.url.href, no_proxy: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, result] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(result, stderr).toBe(0); expect(stdout.trim()).toBe("credential-result");
    expect(requests).toBe(1); expect(proxied).toBe(0);
  } finally { server.stop(true); proxy.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30000);
