import { expect, test } from "bun:test";

// A separate process is necessary: Bun reads its verbose-fetch setting at startup.
test.each(["basic", "bearer", "identity"])("registry %s credentials never reach verbose fetch logs", async (mode) => {
  const password = "test-registry-password-do-not-log";
  const token = "test-registry-bearer-do-not-log";
  const identity = "test-registry-refresh-do-not-log";
  const basic = `Basic ${Buffer.from(`user:${password}`).toString("base64")}`;
  let authenticated = 0, exchanges = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/token") {
      exchanges++;
      if (mode === "identity") expect(await request.text()).toContain(identity);
      else expect(request.headers.get("authorization")).toBe(basic);
      return Response.json({ token, expires_in: 300 });
    }
    if (request.headers.get("authorization") === (mode === "basic" ? basic : `Bearer ${token}`)) {
      authenticated++; return new Response("ok");
    }
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": mode === "basic" ? 'Basic realm="test"' : `Bearer realm="${server.url}token"` } });
  } });
  const credentials = mode === "identity" ? { identityToken: identity } : { username: "user", password };
  const source = `import { RegistryClient } from ${JSON.stringify(new URL("../packages/oci/registry.ts", import.meta.url).pathname)};
    const client = new RegistryClient(${JSON.stringify(server.url.host)}, { insecure: [${JSON.stringify(server.url.host)}], credentials: async () => (${JSON.stringify(credentials)}) });
    const response = await client.request('/v2/'); if (await response.text() !== 'ok') process.exit(1);`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], { env: { ...process.env, BUN_CONFIG_VERBOSE_FETCH: "curl" }, stdout: "pipe", stderr: "pipe" });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(authenticated).toBe(1);
    expect(exchanges).toBe(mode === "basic" ? 0 : 1);
    for (const secret of [password, token, identity, basic]) expect(stdout + stderr).not.toContain(secret);
    expect(stderr.toLowerCase()).not.toContain("authorization:");
  } finally { child.kill(); server.stop(true); }
});
