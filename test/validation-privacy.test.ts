import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { scanPrivateOutput } from "../scripts/validation/privacy.ts";
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path,{recursive:true,force:true}); });
async function fixture() { const path = await mkdtemp(join(tmpdir(),"bunko-privacy-")); roots.push(path); return path; }
test.each(["plain", "gzip", "utf16", "split"])("privacy gate rejects identifiers in %s output without reporting their value", async (kind) => {
  const root = await fixture(), term = "private-organization";
  const data = Buffer.from(`${"x".repeat(kind === "split" ? 65530 : 0)}PRIVATE-ORGANIZATION`,kind === "utf16" ? "utf16le" : "utf8");
  await writeFile(join(root,"blob"),kind === "gzip" ? gzipSync(data) : data);
  await expect(scanPrivateOutput(root,[term])).rejects.toThrow("PRIVATE_IDENTIFIER_DETECTED");
});
test("privacy gate checks filenames and fails closed on unsupported streams, links and limits", async () => {
  const root = await fixture(), file = join(root,"private-organization.json");
  await writeFile(file,"{}"); await expect(scanPrivateOutput(root,["private-organization"])).rejects.toThrow("PRIVATE_IDENTIFIER_DETECTED"); await rm(file);
  await writeFile(join(root,"blob"),Buffer.from([0x28,0xb5,0x2f,0xfd])); await expect(scanPrivateOutput(root,["private-organization"])).rejects.toThrow("UNSUPPORTED_COMPRESSED_OUTPUT");
  await writeFile(join(root,"blob"),gzipSync(Buffer.alloc(10000))); await expect(scanPrivateOutput(root,["private-organization"],100)).rejects.toThrow("OUTPUT_SCAN_LIMIT_EXCEEDED"); await rm(join(root,"blob"));
  await symlink("/nonexistent",file); await expect(scanPrivateOutput(root,["private-organization"])).rejects.toThrow("OUTPUT_SYMLINK_REJECTED");
});
test("privacy gate accepts a clean tree and keeps filesystem errors anonymous", async () => {
  const root = await fixture(); await writeFile(join(root,"report.json"),'{"status":"passed"}');
  expect((await scanPrivateOutput(root,["private-organization"])).files).toBe(1);
  await expect(scanPrivateOutput(join(root,"absent"),["private-organization"])).rejects.toThrow("OUTPUT_SCAN_FAILED");
});

test("privacy gate normalizes root paths and checks raw gzip headers", async () => {
  const root = await fixture(), term = "private-organization";
  await writeFile(join(root,`${term}.json`),"{}");
  await expect(scanPrivateOutput(`${root}/`,[term])).rejects.toThrow("PRIVATE_IDENTIFIER_DETECTED");
  await rm(join(root,`${term}.json`));
  const gzip = gzipSync("clean content");
  gzip[3] = 8;
  await writeFile(join(root,"blob"),Buffer.concat([gzip.subarray(0,10),Buffer.from(`${term}\0`),gzip.subarray(10)]));
  await expect(scanPrivateOutput(root,[term])).rejects.toThrow("PRIVATE_IDENTIFIER_DETECTED");
  await expect(scanPrivateOutput(root,["非公開"])).rejects.toThrow("INVALID_PRIVACY_TERMS");
});

test("privacy CLI emits only a fixed summary and never authorizes publication", async () => {
  const root = await fixture(), terms = join(root,"terms.json"), output = join(root,"output");
  await writeFile(terms,JSON.stringify(["private-organization"]));
  const run = async () => {
    const child = Bun.spawn([process.execPath,join(import.meta.dir,"../scripts/validation/scan-output.ts")],{
      env:{BUNKO_QUARANTINE:output,BUNKO_PRIVATE_TERMS_FILE:terms},stdout:"pipe",stderr:"pipe",
    });
    return {code:await child.exited,out:await new Response(child.stdout).text(),err:await new Response(child.stderr).text()};
  };
  await mkdir(output); await writeFile(join(output,"result.json"),"{}");
  const clean = await run();
  expect(clean.code).toBe(0); expect(clean.err).toBe("");
  expect(JSON.parse(clean.out)).toEqual({schemaVersion:1,identifierGate:"passed",publicationApproved:false});
  await writeFile(join(output,"result.json"),"private-organization");
  const rejected = await run();
  expect(rejected.code).toBe(1); expect(rejected.out).not.toContain("private-organization");
  await rm(output,{recursive:true});
  const missing = await run();
  expect(missing.code).toBe(1); expect(missing.err).toBe("");
  expect(JSON.parse(missing.out)).toEqual({schemaVersion:1,identifierGate:"failed",publicationApproved:false});
});

test("privacy gate rejects an opaque uncompressed tar file", async () => {
  const root = await fixture(), header = Buffer.alloc(512);
  header.write("ustar",257);
  await writeFile(join(root,"archive.tar"),header);
  await expect(scanPrivateOutput(root,["private-organization"])).rejects.toThrow("UNSUPPORTED_COMPRESSED_OUTPUT");
});

test("privacy gate rejects concurrent modifications to previously scanned files", async () => {
  const root = await fixture(), file = join(root,"a-clean");
  await writeFile(file,"clean"); await writeFile(join(root,"z-large"),Buffer.alloc(16 * 1024 * 1024, 120));
  let active = true;
  const writer = (async () => { while (active) { await Bun.sleep(2); await writeFile(file,"clean"); } })();
  try { await expect(scanPrivateOutput(root,["private-organization"])).rejects.toThrow("OUTPUT_CHANGED_DURING_SCAN"); }
  finally { active = false; await writer; }
});
