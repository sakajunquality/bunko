import { runtimePins } from "../packages/bunko/runtime-pins.ts";
import { runtimeNotices } from "../packages/bunko/runtime-notices.ts";
import { spdx, provenance } from "../packages/bunko/attest.ts";
import type { BuildResult, PlatformResult } from "../packages/bunko/build.ts";
import { validateCacheOptions } from "../packages/bunko/cache-options.ts";
import { MockRegistry } from "./mock-registry.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveChecksum, pinnedArchiveChecksum, releaseRevision, assertSignatureStatus, downloadRuntime, extractRuntime, runtimeAsset, runtimeBytes, runtimeELF, verifiedChecksums, type InjectedRuntime } from "../packages/bunko/runtime-download.ts";
import { baseFilesystem, baseNode, runtimeEntries } from "../packages/bunko/runtime-layer.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { project } from "./helpers.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { packLayer } from "../packages/oci/tar.ts";
import { LayerCache, cacheKey, packFormat } from "../packages/bunko/cache.ts";
import { sha256 } from "../packages/oci/digest.ts";
import type { BaseImage } from "../packages/oci/types.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "bunko-runtime-test-")); roots.push(root); return root; }
const platform = { os: "linux", architecture: "arm64" } as const;
const toolchain = { path: "bun", version: "1.3.11", revision: "af24e281e" };

test("runtime injection rejects unsupported modes, libc, versions and destinations before work", async () => {
  const root = await temp();
  for (const config of [{ runtime: { inject: "release" } }, { base: "example/base", mode: "compile", runtime: { inject: "release" } }, { base: "example/base", runtime: { inject: "release", libc: "musl" } }, { base: "example/base", runtime: { inject: "release", bunPath: "/app/node_modules/bun" } }]) {
    await project(root, { bunko: config }); await expect(loadProject({ path: root })).rejects.toThrow();
  }
  expect(runtimeAsset(toolchain, { os: "linux", architecture: "amd64" })).toBe("bun-linux-x64-baseline");
  expect(() => runtimeAsset({ ...toolchain, version: "1.5.0" }, platform)).toThrow("supports official Bun");
  expect(() => validateCacheOptions({localCache:false,runtimeCache:"cache"})).toThrow("requires local caching");
});

test.skipIf(!Bun.which("gpgv"))("official clear-signed checksums verify offline and reject tampering", async () => {
  const signed = await readFile(new URL("./fixtures/runtime/bun-1.3.11-checksums.asc", import.meta.url));
  const checksums = await verifiedChecksums(signed);
  expect(() => pinnedArchiveChecksum("1.3.12","bun-linux-aarch64",checksums)).toThrow("pinned release version");
  expect(archiveChecksum(checksums, "bun-linux-aarch64")).toBe("sha256:d13944da12a53ecc74bf6a720bd1d04c4555c038dfe422365356a7be47691fdf");
  await expect(verifiedChecksums(Buffer.from(signed.toString().replace("bun-linux-aarch64.zip", "bun-linux-unknown.zip")))).rejects.toThrow("signature verification");
  await expect(verifiedChecksums(Buffer.from(checksums))).rejects.toThrow();
  expect(() => archiveChecksum(checksums + "\n" + checksums, "bun-linux-aarch64")).toThrow("duplicate");
  expect(() => archiveChecksum(checksums, "absent")).toThrow("absent");
});

test("downloads retry interrupted bodies, reject foreign redirects and bound bytes", async () => {
  let calls = 0;
  const bytes = await runtimeBytes("https://github.com/release", 10, async () => {
    if (++calls === 1) return new Response(new ReadableStream({ start(c) { c.error(new Error("lost body")); } }));
    return new Response("ok");
  });
  expect(bytes.toString()).toBe("ok"); expect(calls).toBe(2);
  await expect(runtimeBytes("https://github.com/release", 10, async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid/bun" } }))).rejects.toThrow("origin");
  await expect(runtimeBytes("https://github.com/release", 1, async () => new Response("large"))).rejects.toThrow("size limit");
  let forbidden = 0;
  await expect(runtimeBytes("https://github.com/release", 1, async () => { forbidden++; return new Response(null, { status: 404 }); })).rejects.toThrow("404");
  expect(forbidden).toBe(1);
});

async function zip(entries: { name: string; content: string; mode?: number }[]) {
  const root = await temp(), input = join(root, "entries.json"), output = join(root, "fixture.zip");
  await writeFile(input, JSON.stringify(entries));
  const process = Bun.spawn(["python3", "-c", `import zipfile,json,sys
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for e in json.load(open(sys.argv[1])):
  i=zipfile.ZipInfo(e['name']); i.create_system=3; i.external_attr=e.get('mode',0o100755)<<16; z.writestr(i,e['content'])`, input, output], { stdout: "ignore", stderr: "ignore" });
  if (await process.exited) throw new Error("ZIP fixture failed"); return readFile(output);
}

test("ZIP extraction permits only one regular executable and rejects traversal, links and duplicates", async () => {
  const name = "bun-linux-aarch64/bun";
  expect((await extractRuntime(await zip([{ name, content: "binary" }]), "bun-linux-aarch64")).toString()).toBe("binary");
  for (const entries of [[{ name: "../bun", content: "bad" }], [{ name, content: "target", mode: 0o120777 }], [{ name, content: "first" }, { name, content: "second" }], [{ name: "other", content: "bad" }]]) await expect(extractRuntime(await zip(entries), "bun-linux-aarch64")).rejects.toThrow();
});

function elf() {
  const b = Buffer.alloc(1024); b.write("\x7fELF"); b[4]=2; b[5]=1; b.writeUInt16LE(3,16); b.writeUInt16LE(183,18); b.writeBigUInt64LE(64n,32); b.writeUInt16LE(56,54); b.writeUInt16LE(3,56);
  function segment(index:number,type:number,offset:number,size:number) { const p=64+index*56; b.writeUInt32LE(type,p); b.writeBigUInt64LE(BigInt(offset),p+8); b.writeBigUInt64LE(BigInt(offset),p+16); b.writeBigUInt64LE(BigInt(size),p+32); }
  segment(0,1,0,1024); const interpreter="/lib/ld-linux-aarch64.so.1\0"; b.write(interpreter,300); segment(1,3,300,interpreter.length); segment(2,2,400,64);
  const strings="\0libc.so.6\0GLIBC_2.25\0"; b.write(strings,600);
  for(const [i,[tag,value]] of [[5,600],[10,strings.length],[1,1],[0,0]].entries()) { b.writeBigUInt64LE(BigInt(tag!),400+i*16); b.writeBigUInt64LE(BigInt(value!),408+i*16); }
  return b;
}

test("ELF inspection checks architecture, bounds, loader, libraries and symbol versions", () => {
  expect(runtimeELF(elf(),platform)).toEqual({ interpreter:"/lib/ld-linux-aarch64.so.1", needed:["libc.so.6"], glibcSymbols:["GLIBC_2.25"] });
  expect(() => runtimeELF(elf(),{os:"linux",architecture:"amd64"})).toThrow("ELF64");
  expect(() => runtimeELF(elf().subarray(0,64),platform)).toThrow();
  const bad=elf(); bad.writeBigUInt64LE(999999n,32); expect(() => runtimeELF(bad,platform)).toThrow();
});

test("base metadata handles whiteouts and links without extracting host files", async () => {
  const root=await temp(), store=new BlobStore(join(root,"store"));
  const first=(await packLayer(store,[{path:"lib/loader",type:"file",content:Buffer.from("loader"),executable:true},{path:"other/gone",type:"file",content:Buffer.from("gone")},{path:"lib/old",type:"file",content:Buffer.from("old")},{path:"lib/link",type:"symlink",target:"loader"}],"assets",0))!;
  const archive=join(root,"overlay.tar");
  const child=Bun.spawn(["python3","-c", "import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w') as t:\n for name,data in [('lib/.wh..wh..opq',b''),('lib/new',b'new'),('other/.wh.gone',b'')]:\n  i=tarfile.TarInfo(name); i.size=len(data); t.addfile(i,io.BytesIO(data))",archive],{stdout:"ignore",stderr:"ignore"});
  expect(await child.exited).toBe(0);
  const bytes=await readFile(archive),second={descriptor:await store.put(bytes,"application/vnd.oci.image.layer.v1.tar"),diffId:sha256(bytes)};
  const base={manifest:{layers:[first.descriptor,second.descriptor]},config:{rootfs:{diff_ids:[first.diffId,second.diffId]}}} as BaseImage;
  const tree=await baseFilesystem(store,base,root);
  expect(tree.has("other/gone")).toBe(false); expect(tree.has("lib/old")).toBe(false); expect(tree.has("lib/new")).toBe(true);
  tree.set("lib/loader",{type:"file",mode:0o755,size:10}); tree.set("lib/ld-linux-aarch64.so.1",{type:"symlink",link:"loader",mode:0o777,size:0});
  expect(baseNode(tree,"/lib/ld-linux-aarch64.so.1")!.type).toBe("file");
  tree.set("lib/hard",{type:"link",link:"lib/loader",mode:0o755,size:0});
  tree.set("lib64",{type:"symlink",link:"/lib",mode:0o777,size:0});
  expect(baseNode(tree,"/lib64/hard")!.size).toBe(10);
  tree.set("lib/a",{type:"symlink",link:"b",mode:0o777,size:0}); tree.set("lib/b",{type:"symlink",link:"a",mode:0o777,size:0});
  expect(()=>baseNode(tree,"/lib/a")).toThrow("link cycle");
  const metadata={path:"/usr/local/bin/bun",interpreter:"/lib/ld-linux-aarch64.so.1"} as InjectedRuntime;
  expect(runtimeEntries(metadata,elf(),tree)[0]!.path).toBe("usr/local/bin/bun");
  tree.set("usr/local",{type:"symlink",link:"/outside",mode:0o777,size:0}); expect(()=>runtimeEntries(metadata,elf(),tree)).toThrow("parent");
  tree.delete("usr/local"); tree.delete("lib/loader"); expect(()=>runtimeEntries(metadata,elf(),tree)).toThrow("loader");
});

test("runtime layer records survive local and registry cache serialization", async () => {
  const root=await temp(),store=new BlobStore(join(root,"store")),directory=join(root,"cache");
  const layer=(await packLayer(store,[{path:"usr/local/bin/bun",type:"file",content:elf(),executable:true}],"runtime",0))!;
  const key=cacheKey({kind:"runtime",digest:sha256(elf())});
  const record={schemaVersion:1 as const,key,kind:"runtime" as const,packFormat,destination:"/usr/local/bin/bun",platform,layer,inventory:[],native:[]};
  const cache=new LayerCache(store,{directory,log:()=>{}}); await cache.remember(record);
  const next=new LayerCache(new BlobStore(join(root,"next")),{directory,log:()=>{}});
  expect((await next.get(key,"runtime",false,{destination:record.destination,platform}))!.layer).toEqual(layer);
  const mock = new MockRegistry(), registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const producer = new LayerCache(store,{repository:"registry.test/runtime",registry,log:()=>{}});
  await producer.remember(record); await producer.publish();
  const consumer = new LayerCache(new BlobStore(join(root,"remote")),{readRepositories:["registry.test/runtime"],registry,log:()=>{}});
  expect((await consumer.get(key,"runtime",false,{destination:record.destination,platform}))!.layer).toEqual(layer);
  expect(consumer.events[0]!.status).toBe("registry");
});


test.skipIf(!Bun.which("gpgv"))("corrupt cached archives cannot bypass signed checksums or replace cache contents", async () => {
  const root = await temp(), dir = join(root,"1.3.11-bun-linux-aarch64");
  await mkdir(dir);
  await writeFile(join(dir,"SHASUMS256.txt.asc"),await readFile(new URL("./fixtures/runtime/bun-1.3.11-checksums.asc",import.meta.url)));
  const archive=join(dir,"bun-linux-aarch64.zip"); await writeFile(archive,"corrupt cached bytes");
  const requests:string[]=[], logs:string[]=[];
  await expect(downloadRuntime(toolchain,platform,{cache:root,log:(line)=>logs.push(line),fetcher:async(url)=>{requests.push(url);return new Response("unverified replacement");}})).rejects.toThrow("checksum mismatch");
  expect(logs.join("")).toContain("cache entry failed verification");
  expect(requests.length).toBe(1); expect(requests[0]!.endsWith("/bun-linux-aarch64.zip")).toBe(true);
  expect(await readFile(archive,"utf8")).toBe("corrupt cached bytes");
});


test("revision matching skips partial strings and signature errors fail closed", () => {
  const revision="af24e281ebacd6ac77c0f14b4206599cf4ae1c9f";
  expect(releaseRevision(Buffer.from(`\0af24e281e-partial\0${revision}\0`),toolchain)).toBe(revision);
  expect(()=>releaseRevision(Buffer.from(`\0${revision}\0`),{...toolchain,revision:"bad123456"})).toThrow("toolchain revision");
  const valid="[GNUPG:] VALIDSIG F3DCC08A8572C0749B3E18888EAB4D40A7B22B59 2026-01-01 1 0 4 0 22 10 01 F3DCC08A8572C0749B3E18888EAB4D40A7B22B59\n";
  assertSignatureStatus(valid,0);
  for(const status of ["EXPKEYSIG","REVKEYSIG","EXPSIG","BADSIG","ERRSIG","NO_PUBKEY"]) expect(()=>assertSignatureStatus(valid+`[GNUPG:] ${status} detail\n`,0)).toThrow("signature verification");
});

test("SBOM separates release archive and executable hashes; provenance includes signature inputs", () => {
  const archiveDigest=sha256("archive"),executableDigest=sha256("executable"),checksumDocumentDigest=sha256("signed checksums");
  const runtime={source:"github-release",version:"1.3.11",expectedRevision:"af24e281e",releaseRevision:"af24e281ebacd6ac77c0f14b4206599cf4ae1c9f",revisionVerified:false,archiveDigest,executableDigest,checksumDocumentDigest,path:"/usr/local/bin/bun",url:"https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-aarch64.zip",policy:"bun-release-gpg-pinned-v1",signer:"F3DCC08A8572C0749B3E18888EAB4D40A7B22B59"} as InjectedRuntime;
  const image={runtime,platform,manifest:{digest:sha256("image")},baseDigest:sha256("base"),inventory:[],native:[]} as unknown as PlatformResult;
  const document=spdx("fixture",image,0,{version:runtime.version,revision:runtime.expectedRevision,embedded:false});
  const pkg=document.packages.find(p=>p.SPDXID==="SPDXRef-Bun-Runtime") as {checksums:{checksumValue:string}[]};
  expect(pkg.checksums[0]!.checksumValue).toBe(archiveDigest.slice(7));
  expect(document.files![0]!.checksums[0]!.checksumValue).toBe(executableDigest.slice(7));
  const record=provenance({target:"fixture",root:image.manifest,sourceDigest:sha256("source"),toolchain:{version:runtime.version,revision:runtime.expectedRevision},images:[image]} as BuildResult);
  expect(JSON.stringify(record)).toContain(checksumDocumentDigest.slice(7)); expect(JSON.stringify(record)).toContain(runtime.signer);
  const { path, ...compileRuntime } = runtime;
  const compiledImage = { ...image, runtime: undefined, compileRuntime };
  const compiledDocument = spdx("compiled", compiledImage, 0, { version: runtime.version, revision: runtime.expectedRevision, embedded: true });
  expect(compiledDocument.files).toBeUndefined();
  const compiledPackage = compiledDocument.packages.find((p) => p.SPDXID === "SPDXRef-Bun-Runtime") as { checksums: { checksumValue: string }[]; comment: string };
  expect(compiledPackage.checksums[0]!.checksumValue).toBe(archiveDigest.slice(7));
  expect(compiledPackage.comment).toContain("Embedded signed release");
  expect(JSON.stringify(provenance({ target: "compiled", root: image.manifest, sourceDigest: sha256("source"), toolchain: { version: runtime.version, revision: runtime.expectedRevision }, images: [compiledImage] } as BuildResult))).toContain(checksumDocumentDigest.slice(7));
});

test.skipIf(!Bun.which("gpgv"))("every supported Linux asset pin matches the official signed fixture", async () => {
  expect(Object.keys(runtimeNotices).sort()).toEqual(Object.keys(runtimePins).sort());
  for(const version of Object.keys(runtimePins)) {
    expect(runtimeNotices[version]).toContain("MIT License");
    const signed=await readFile(new URL(`./fixtures/runtime/bun-${version}-checksums.asc`,import.meta.url));
    const text=await verifiedChecksums(signed);
    for(const asset of ["bun-linux-x64-baseline","bun-linux-aarch64"]) expect(pinnedArchiveChecksum(version,asset,text)).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
});
