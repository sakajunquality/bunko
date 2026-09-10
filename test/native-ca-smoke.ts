import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { baseLayout } from "./helpers.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-native-ca-"));
try {
  const source = join(directory, "source"), key = join(directory, "server.key");
  await mkdir(join(source, "dist"), { recursive: true });
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", join(source, "ca.pem")]);
  await chmod(key, 0o444);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "native-ca", module: "index.ts", bunko: { assets: ["dist/probe"], runtime: { caCertificates: ["ca.pem"], systemCaTrust: true } } }));
  await writeFile(join(source, "index.ts"), 'console.log("native CA fixture");');
  await writeFile(join(source, ".gitignore"), "dist/\n");
  const program = join(directory, "probe.go");
  await writeFile(program, `package main
import ("crypto/tls"; "fmt"; "io"; "net/http"; "os"; "time")
func main() {
  cert, err := tls.LoadX509KeyPair("/app/.bunko-ca/roots.pem", "/fixtures/server.key"); if err != nil { panic(err) }
  listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}}); if err != nil { panic(err) }
  server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "native TLS works") })}
  go server.Serve(listener); defer server.Close()
  client := &http.Client{Timeout: 5 * time.Second}
  response, err := client.Get("https://" + listener.Addr().String()); if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
  defer response.Body.Close(); body, err := io.ReadAll(response.Body); if err != nil { panic(err) }; fmt.Println(string(body))
}
`);
  for (const platform of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) {
    const architecture = platform.split("/")[1];
    if (architecture !== "amd64" && architecture !== "arm64") throw new Error("Unsupported smoke platform");
    const child = Bun.spawn(["go", "build", "-trimpath", "-o", join(source, "dist/probe"), program], { env: { ...process.env, GOOS: "linux", GOARCH: architecture, CGO_ENABLED: "0" }, stdout: "pipe", stderr: "pipe" });
    const [error, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (exit) throw new Error(`Go probe compilation failed: ${error}`);
    const tarball = join(directory, `${architecture}.tar`);
    // A minimal base has no trust store; the packaged CA must supply the trust.
    const base = await baseLayout(join(directory, `base-${architecture}`), { os: "linux", architecture });
    if (process.env.BUNKO_CLI) await command([process.execPath, resolve(process.env.BUNKO_CLI), "build", source, "--mode", "source", "--platform", platform, "--base-layout", base, "--tarball", tarball, "--push=false", "--no-local-cache", "--git-metadata=false"]);
    else await build({ path: source, mode: "source", platform, baseLayout: base, tarball, push: false, localCache: false, gitMetadata: false });
    const loaded = await command(["docker", "load", "--input", tarball]), image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw new Error("Docker did not load the native CA fixture");
    try {
      const args = ["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65532:65532", "--mount", `type=bind,source=${key},target=/fixtures/server.key,readonly`, "--entrypoint", "/app/dist/probe"];
      if (await command([...args, image]) !== "native TLS works") throw new Error("Native CA trust failed");
      const negative = Bun.spawn([...args, "--env", "SSL_CERT_FILE=/missing.pem", "--env", "SSL_CERT_DIR=/missing", image], { stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(negative.stderr).text(), negative.exited]);
      if (!code || !stderr.includes("certificate signed by unknown authority")) throw new Error(`Expected an untrusted native TLS failure: ${stderr}`);
      console.log(`PASS: ${platform} gitignored native asset runs with declared CA trust; removing trust fails`);
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
