/** Disposable functional acceptance fixture. No application credentials are used. */
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../../packages/oci/blob-store.ts";
import { exportDockerArchive } from "../../packages/oci/archive.ts";
import type { BuildResult } from "../../packages/bunko/build.ts";
import { scanPrivateOutput } from "./privacy.ts";

const base = "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9";
const database = "postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const root = await mkdtemp(join(tmpdir(), "bunko-acceptance-")); await chmod(root,0o700);
const id = randomUUID(), network = `bunko-acceptance-${id}`, db = `bunko-db-${id}`;
const containers = new Set<string>(), images = new Set<string>(); let networkCreated = false;
const checks: Record<string, boolean> = {};
async function command(args: string[], timeout = 120000): Promise<string> {
  const child = Bun.spawn(args,{stdout:"pipe",stderr:"pipe"});
  const timer = setTimeout(() => child.kill("SIGKILL"),timeout);
  try {
    const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if (code) { await writeFile(join(root,"command.log"),out+err,{mode:0o600}); throw new Error("ACCEPTANCE_COMMAND_FAILED"); }
    return out.trim();
  } finally { clearTimeout(timer); }
}
async function eventually(check: () => Promise<void>) {
  for (let i=0;i<100;i++) { try {await check();return;} catch {await Bun.sleep(100);} }
  throw new Error("ACCEPTANCE_NOT_READY");
}
try {
  await command(["docker","pull",database],300000);
  await command(["docker","network","create","--internal",network]); networkCreated=true;
  const password = randomUUID();
  await command(["docker","run","--detach","--name",db,"--network",network,"--network-alias","database","--env",`POSTGRES_PASSWORD=${password}`,"--env","POSTGRES_DB=acceptance","--tmpfs","/var/lib/postgresql/data:rw",database]); containers.add(db);
  await eventually(async () => {await command(["docker","exec",db,"pg_isready","-U","postgres","-d","acceptance"]);});
  const source = join(root,"source"), inputs = join(root,"generated");
  await cp(resolve("examples/application-validation"),source,{recursive:true,filter:path=>!path.split("/").includes("node_modules")});
  await mkdir(inputs); await writeFile(join(inputs,"settings.json"),JSON.stringify({message:"configured-content"}));
  const layout=join(root,"layout"), report=join(root,"raw-report.json");
  await command([process.execPath,resolve("dist/bunko.js"),"build",source,"--base",base,"--platform",process.env.BUNKO_SMOKE_PLATFORMS??"linux/amd64,linux/arm64","--asset-context",`generated=${inputs}`,"--oci-layout",layout,"--report",report,"--push=false","--no-cache","--git-metadata=false"],300000);
  const built=JSON.parse(await readFile(report,"utf8")) as BuildResult;
  await scanPrivateOutput(layout,["private-organization-sentinel"]);
  checks.artifactGate=true;
  for (const image of built.images) {
    const arch=image.platform.architecture, platform=`linux/${arch}`, tag=`bunko.local/acceptance-${id}:${arch}`;
    const archive=join(root,`${arch}.tar`); await exportDockerArchive(new BlobStore(layout),image.manifest,archive,tag,0);
    await command(["docker","load","--input",archive]); images.add(tag);
    const env=["--env",`DATABASE_URL=postgresql://postgres:${password}@database:5432/acceptance`];
    const common=["--platform",platform,"--network",network,"--read-only","--cap-drop=ALL","--tmpfs","/tmp:rw,noexec,nosuid",...env];
    for (const role of ["migrate","worker"]) {
      const name=`bunko-${role}-${id}-${arch}`; containers.add(name);
      await command(["docker","run","--name",name,...common,tag,image.entrypoints![role]!]);
      checks[`${arch}.${role}`]=true;
    }
    const rows=await command(["docker","exec",db,"psql","-U","postgres","-d","acceptance","-Atc","SELECT key || ':' || value FROM acceptance ORDER BY key"]);
    if (rows!=="migration:applied\nworker:processed") throw new Error("DATABASE_ASSERTION_FAILED");
    checks[`${arch}.database`]=true;
    const server=`bunko-server-${id}-${arch}`; containers.add(server);
    await command(["docker","run","--detach","--name",server,...common,tag]);
    const info=JSON.parse(await command(["docker","inspect",server]))[0];
    if(info.Config.User!=="65532:65532" || !info.HostConfig.ReadonlyRootfs) throw new Error("RUNTIME_POLICY_FAILED");
    async function http(path: string) {
      return JSON.parse(await command(["docker","exec",server,"/usr/local/bin/bun","-e",`const r=await fetch(${JSON.stringify("http://127.0.0.1:3000")}+${JSON.stringify(path)},{signal:AbortSignal.timeout(2000)}); console.log(JSON.stringify({ok:r.ok,body:await r.text()}));`]));
    }
    await eventually(async () => {
      const response=await http("/api/acceptance");
      if (!response.ok) throw new Error("HTTP_ASSERTION_FAILED");
      const value=JSON.parse(response.body) as Record<string,unknown>;
      if(value.settings!=="configured-content" || value.prompt!=="Expected application prompt.\n" || value.migration!=="applied" || value.hash!==510391394) throw new Error("CONTENT_ASSERTION_FAILED");
    });
    for(const [path,expected] of [["/","Fixture application"],["/assets/app.js","dataset.ready"]]) {
      const response=await http(path!);
      if(!response.ok || !response.body.includes(expected!)) throw new Error("STATIC_ASSET_ASSERTION_FAILED");
    }
    checks[`${arch}.httpNativeAndFiles`]=true;
    await command(["docker","stop","--time","5",server]);
    const state=JSON.parse(await command(["docker","inspect",server]))[0].State;
    if(state.ExitCode!==0 || state.OOMKilled) throw new Error("SHUTDOWN_ASSERTION_FAILED");
    checks[`${arch}.shutdown`]=true;
    await command(["docker","exec",db,"psql","-U","postgres","-d","acceptance","-c","DROP TABLE acceptance"]);
  }
  console.log(JSON.stringify({schemaVersion:1,status:"passed",checks}));
} catch(error) {
  console.log(JSON.stringify({schemaVersion:1,status:"failed",checks}));
  console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:"ACCEPTANCE_FAILED"); process.exitCode=1;
} finally {
  for(const name of containers) await command(["docker","rm","--force",name]).catch(()=>{});
  for(const tag of images) await command(["docker","image","rm",tag]).catch(()=>{});
  if(networkCreated) await command(["docker","network","rm",network]).catch(()=>{});
  await rm(root,{recursive:true,force:true});
}
