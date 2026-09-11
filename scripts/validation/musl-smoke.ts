/** Public Alpine fixtures: real runtimes, native addons, private CA trust and cold/warm builds. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const base = "oven/bun@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f";
const bare = "alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b";
const glibc = "gcr.io/distroless/base-debian12@sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5";
const cli = [process.execPath, resolve("dist/bunko.js")];
const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
const root = await mkdtemp(join(tmpdir(), "bunko-musl-smoke-")), images = new Set<string>(), containers = new Set<string>();
async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, {cwd, stdout:"pipe", stderr:"pipe"});
  const timer = setTimeout(() => child.kill(), 300000);
  try { const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]); return {out,err,code}; }
  finally { clearTimeout(timer); }
}
async function good(args: string[], cwd = root) { const r=await run(args,cwd); if(r.code) throw new Error(r.err || r.out); return r.out; }
try {
  const project=join(root,'app'); await mkdir(join(project,'tls'),{recursive:true});
  await good(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout','../server.key','-out','tls/ca.crt','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','basicConstraints=critical,CA:TRUE'],project);
  await chmod(join(root,'server.key'),0o644); // Disposable test key, mounted only for runtime validation.
  const manifest: any = {name:'musl-validation',version:'1.0.0',dependencies:{'@node-rs/xxhash':'1.7.6'}};
  await writeFile(join(project,'package.json'),JSON.stringify(manifest));
  await good([process.execPath,'install','--ignore-scripts'],project);
  for (const mode of ['bundle','source','compile']) {
    await writeFile(join(project,'index.ts'), `${mode==='compile'?'':'import {xxh32} from "@node-rs/xxhash";'}
const server=Bun.serve({hostname:'127.0.0.1',port:0,tls:{key:Bun.file('/run/tls/server.key'),cert:Bun.file('/app/tls/ca.crt')},fetch:()=>new Response('trusted')});
try { const text=await (await fetch('https://localhost:'+server.port)).text(); console.log(JSON.stringify({text,version:Bun.version,hash:${mode==='compile'?'0':'xxh32("bunko")'}})); } finally {server.stop(true);}
`);
    manifest.bunko={mode,entrypoint:'index.ts',external:mode==='compile'?[]:['@node-rs/xxhash'],assets:['tls'],runtime:{libc:'musl',caCertificates:['tls/ca.crt'],...(mode==='compile'?{}:{inject:'release',bunPath:'/opt/bunko/bun'})}};
    await writeFile(join(project,'package.json'),JSON.stringify(manifest));
    for(const platform of platforms) {
      const archive=join(root,`${mode}-${platform.split('/')[1]}.tar`), report=join(root,`${mode}-${platform.split('/')[1]}.json`);
      await good([...cli,'build',project,'--base',base,'--cache-dir',join(root,'cache'),'--platform',platform,'--push=false','--tarball',archive,'--report',report]);
      const data=await Bun.file(report).json(), runtime=data.images[0].runtime ?? data.images[0].compileRuntime;
      if(runtime.libc!=='musl') throw new Error('Missing musl runtime evidence');
      const loaded=await good(['docker','load','-i',archive]);
      const image=/Loaded image: (.+)/.exec(loaded)?.[1]; if(!image) throw new Error('No loaded image'); images.add(image);
      const container=`bunko-musl-${randomUUID()}`; containers.add(container);
      const out=JSON.parse(await good(['docker','run','--name',container,'--rm','--platform',platform,'--read-only','--network','none','--cap-drop=ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${join(root,'server.key')},target=/run/tls/server.key,readonly`,image]));
      if(out.text!=='trusted'||out.version!==Bun.version||(mode!=='compile'&&!Number.isInteger(out.hash))) throw new Error('Native/TLS/runtime acceptance failed');
      await rm(archive);
      await good([...cli,'build',project,'--base',base,'--cache-dir',join(root,'cache'),'--platform',platform,'--push=false','--tarball',archive,'--report',report]);
      const warm=await Bun.file(report).json();
      if(warm.root.digest!==data.root.digest || !warm.cache.some((event:any)=>event.kind==="app" && event.status==="local")) throw new Error("Warm cache did not preserve the image and reuse application bytes");
      console.log(JSON.stringify({mode,platform,version:out.version,libc:runtime.libc,archiveDigest:runtime.archiveDigest,https:out.text,native:mode!=='compile',warm:true}));
    }
  }
  for(const [reference,expected] of [[glibc,'musl runtime base requires'],[bare,'missing libstdc++.so.6']]) {
    const result=await run([...cli,'check-base','--base',reference!,'--runtime-libc','musl','--runtime-inject','release','--platform',platforms[0]!]);
    if(!result.code||!result.err.includes(expected!)) throw new Error(`Expected rejection: ${expected}: ${result.err}`);
  }
  if (Bun.version === "1.4.2") {
  const direct=JSON.parse(await good([...cli,'check-base','--base',base,'--runtime-libc','musl','--platform',platforms.join(','),'--run']));
  if(direct.platforms.some((p:any)=>!p.runtimeVerified)) throw new Error('Existing Alpine Bun failed execution');
  }
  console.log('musl negative base checks passed');
} finally {
  for(const container of containers) await run(["docker","rm","--force",container]);
  for(const image of images) await run(['docker','image','rm',image]);
  await rm(root,{recursive:true,force:true});
}
