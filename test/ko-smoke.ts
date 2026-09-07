import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { command } from "./command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-ko-smoke-"));
try {
  const source = join(root, "source"); await mkdir(join(source, "bunkodata"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "data-example", module: "index.ts" }));
  await writeFile(join(source, "bunkodata/message.txt"), "conventional data works");
  await writeFile(join(source, "index.ts"), 'console.log(JSON.stringify({path:process.env.BUNKO_DATA_PATH,text:await Bun.file(`${process.env.BUNKO_DATA_PATH}/message.txt`).text()}));');
  for (const platform of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) for (const mode of ["bundle", "compile"]) {
    const tarball = join(root, `${mode}-${platform.split("/")[1]}.tar`);
    const result = await build({ path: source, platform, mode, tarball, push: false, gitMetadata: false, localCache: false,
      imageLabels: { "example.test/team": "runtime" }, imageAnnotations: { "example.test/review": "ko-parity" }, imageUser: "65532:65532" });
    const image = /Loaded image: (.+)/.exec(await command(["docker", "load", "--input", tarball]))?.[1];
    if (!image) throw new Error("Image load failed");
    try {
      const output = JSON.parse(await command(["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", image]));
      if (output.path !== "/app/bunkodata" || output.text !== "conventional data works") throw new Error("Conventional data runtime failed");
      const config = JSON.parse(await command(["docker", "image", "inspect", image]))[0].Config;
      if (config.User !== "65532:65532" || config.Labels["example.test/team"] !== "runtime") throw new Error("Image metadata runtime mismatch");
      console.log(JSON.stringify({ platform, mode, digest: result.root.digest, data: "passed" }));
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
