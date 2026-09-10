import { afterEach, expect, test } from "bun:test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { cacheMetadataLimit, closurePlanLayout, packFormat, validateClosurePlan } from "../packages/bunko/cache.ts";
import { pruneRegistry } from "../packages/bunko/prune.ts";
import { canonicalJSON, sha256 } from "../packages/oci/digest.ts";
import { media } from "../packages/oci/types.ts";
import type { ProgressEvent } from "../packages/bunko/progress.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return root; }
/** Collects the log text and the phases a build ran, so a skipped install is observable directly. */
function recorder() {
  const events: ProgressEvent[] = [];
  const state = { log: "", events, phases: () => events.filter((e) => e.status === "completed").map((e) => e.phase) };
  return { state, options: { log: (text: string) => { state.log += text; }, progress: (event: ProgressEvent) => events.push(event) } };
}
const repo = "registry.test/cache";
const planKeys = (mock: MockRegistry) => [...mock.manifests.keys()].filter((key) => key.startsWith(`${repo}/bunko-cache-v1-deps-plan-`));
/** The published plan artifact, read back the way a consuming build reads it. */
function planArtifact(mock: MockRegistry, tagKey = planKeys(mock)[0]!) {
  const manifest = JSON.parse(Buffer.from(mock.manifests.get(tagKey)!.bytes).toString());
  const record = JSON.parse(Buffer.from(mock.blobs.get(`${repo}/${manifest.config.digest}`)!).toString());
  return { tagKey, manifest, record };
}
/** Republishes one plan tag with a caller-supplied config body, as a hostile or stale cache repository would hold it. */
function reseed(mock: MockRegistry, tagKey: string, config: Uint8Array, corruptBlob = false): void {
  const previous = JSON.parse(Buffer.from(mock.manifests.get(tagKey)!.bytes).toString());
  const digest = sha256(config);
  mock.blobs.set(`${repo}/${digest}`, corruptBlob ? Buffer.from("not the promised bytes") : config);
  const manifest = canonicalJSON({ ...previous, config: { mediaType: previous.config.mediaType, digest, size: config.length } });
  mock.manifests.set(tagKey, { bytes: manifest, type: media.manifest });
}

async function setup(root: string) {
  const f = await dependencyFixture(root), mock = new MockRegistry();
  const registry = { credentials: async () => undefined, fetcher: mock.fetch };
  const options = { path: f.source, baseLayout: await baseLayout(join(root, "base")), push: false, gitMetadata: false,
    installCache: f.cache, depsStrategy: "closure" as const, cacheRepo: repo, registry };
  return { f, mock, registry, options };
}

test("a registry cache build publishes the closure plan as its own validated artifact", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  const result = await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "image") });
  expect(planKeys(mock)).toHaveLength(1);
  const { tagKey, manifest, record } = planArtifact(mock);
  // The tag follows the layer scheme with the record's own kind, so retention can tell plans apart.
  expect(tagKey).toBe(`${repo}/bunko-cache-v1-deps-plan-${record.planKey.slice(7)}`);
  expect(manifest.artifactType).toBe("application/vnd.bunko.cache.v1");
  expect(manifest.config.mediaType).toBe("application/vnd.bunko.cache.plan.config.v1+json");
  expect(manifest.layers).toHaveLength(1);
  expect(manifest.layers[0].mediaType).toBe("application/vnd.oci.empty.v1+json");
  expect(manifest.annotations).toEqual({ "org.bunko.cache.key": record.planKey, "org.bunko.cache.kind": "deps-plan",
    "org.bunko.cache.plan.layout": closurePlanLayout, "org.bunko.cache.pack.format": packFormat });
  // The published bytes are exactly the record the local index holds, so the same validator accepts both.
  const platform = { os: "linux" as const, architecture: "amd64" as const };
  const plan = validateClosurePlan(record, record.planKey, { destination: record.destination, platform });
  // Workspace target names are data, including names inherited by ordinary objects.
  const named = validateClosurePlan({ ...record, aliases: JSON.parse('{"__proto__":[],"constructor":[]}') }, record.planKey, { destination: record.destination, platform });
  expect(Object.hasOwn(named.aliases, "__proto__")).toBe(true);
  expect(named.aliases.__proto__).toEqual([]);
  expect(named.aliases.constructor).toEqual([]);
  expect(named.aliases.toString).toBeUndefined();
  expect(JSON.parse(Buffer.from(canonicalJSON(named)).toString()).aliases).toEqual(JSON.parse('{"__proto__":[],"constructor":[]}'));
  // The plan is an index: the deps artifact it names is in the same repository.
  expect(mock.manifests.has(`${repo}/bunko-cache-v1-deps-${plan.key.slice(7)}`)).toBe(true);
  expect(result.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "not-found" });
  expect(result.cacheExports!.some((entry) => entry.kind === "deps-plan" && entry.status === "written")).toBe(true);
}, 30_000);

test("a fresh local cache reuses the closure from the registry plan and writes it through", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  const first = await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  const fresh = join(root, "fresh-runner-cache");
  const warm = recorder(), second = await build({ ...options, ...warm.options, cacheDir: fresh, output: join(root, "warm") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64) from registry plan");
  expect(warm.state.log).not.toContain("Planning Linux dependency closure");
  expect(warm.state.phases()).not.toContain("install");
  expect(second.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "registry", source: repo });
  expect(second.root).toEqual(first.root);
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
  // The registry record becomes a local one, so the next build on this runner never leaves the machine.
  expect((await readdir(join(fresh, "plans", "deps"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  const local = recorder();
  await build({ ...options, ...local.options, cacheDir: fresh, output: join(root, "local") });
  expect(local.state.log).toContain("Reusing dependency closure (amd64)\n");
  expect(local.state.phases()).not.toContain("install");
}, 40_000);

test("a mismatched or corrupt registry plan is a miss with a reason, never a build failure", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  const { tagKey, record } = planArtifact(mock);
  // Schema-valid bytes that describe another destination: the reader must reject the identity, not trust the tag.
  reseed(mock, tagKey, canonicalJSON({ ...record, destination: "/elsewhere/node_modules" }));
  const mismatched = recorder();
  const second = await build({ ...options, ...mismatched.options, cacheDir: join(root, "mismatch"), output: join(root, "mismatch-image") });
  expect(mismatched.state.log).not.toContain("Reusing dependency closure");
  expect(mismatched.state.phases()).toContain("install");
  expect(second.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "invalid-or-unavailable" });
  // Bytes that do not hash to the descriptor they are served under.
  reseed(mock, tagKey, canonicalJSON(record), true);
  const corrupt = recorder();
  const third = await build({ ...options, ...corrupt.options, cacheDir: join(root, "corrupt"), output: join(root, "corrupt-image") });
  expect(corrupt.state.log).not.toContain("Reusing dependency closure");
  expect(corrupt.state.phases()).toContain("install");
  expect(third.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "invalid-or-unavailable" });
}, 60_000);

test("cache-write=false publishes no plan, and no-cache and verify-deterministic never consult one", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  await build({ ...options, cacheWrite: false, cacheDir: join(root, "no-write"), output: join(root, "no-write-image") });
  expect(planKeys(mock)).toHaveLength(0);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "seed") });
  expect(planKeys(mock)).toHaveLength(1);
  mock.requests.length = 0;
  const disabled = recorder();
  const off = await build({ ...options, ...disabled.options, localCache: false, registryCache: false, output: join(root, "off") });
  expect(mock.requests).toHaveLength(0);
  expect(disabled.state.log).not.toContain("Reusing dependency closure");
  expect(off.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "bypass", reason: "disabled" });
  const verified = recorder();
  const twice = await build({ ...options, ...verified.options, verifyDeterministic: true, cacheDir: join(root, "verify"), output: join(root, "verify-image") });
  expect(verified.state.log).not.toContain("Reusing dependency closure");
  // One lookup per platform per determinism iteration, every one of them bypassed.
  const planEvents = twice.cache.filter((event) => event.kind === "deps-plan");
  expect(planEvents).toHaveLength(2);
  expect(planEvents.every((event) => event.status === "bypass" && event.reason === "disabled")).toBe(true);
}, 60_000);

test("a poisoned registry plan alias is a miss, not an exception raised after the closure is accepted", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  const { tagKey, record } = planArtifact(mock);
  const target = Object.keys(record.aliases)[0]!;
  expect(record.aliases[target].length).toBeGreaterThan(0);
  // Structurally a symlink, but one layer packing would refuse; accepting it would fail the build
  // from inside pack, long after the closure was reused, and under the default warn policy.
  const poisoned = { ...record, aliases: { ...record.aliases, [target]: [{ ...record.aliases[target][0], target: "/etc/passwd" }] } };
  reseed(mock, tagKey, canonicalJSON(poisoned));
  const unsafe = recorder();
  const result = await build({ ...options, ...unsafe.options, cacheDir: join(root, "unsafe"), output: join(root, "unsafe-image") });
  expect(unsafe.state.log).not.toContain("Reusing dependency closure");
  expect(unsafe.state.phases()).toContain("install");
  expect(result.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "invalid-or-unavailable" });
  // The same validator guards an escaping relative target, a duplicate entry and a pair of paths
  // that differ only in case, which layer packing refuses as a case collision.
  const first = record.aliases[target][0];
  const variants = {
    escaping: [{ ...first, target: `${"../".repeat(12)}etc/passwd` }],
    duplicate: [first, first],
    "case-colliding": [first, { ...first, path: first.path.toUpperCase() }],
    "control-character": [{ ...first, target: `${first.target}\u0001` }],
  };
  for (const [name, aliases] of Object.entries(variants)) {
    reseed(mock, tagKey, canonicalJSON({ ...record, aliases: { ...record.aliases, [target]: aliases } }));
    const run = recorder();
    const built = await build({ ...options, ...run.options, cacheDir: join(root, name), output: join(root, `${name}-image`) });
    expect([name, run.state.phases().includes("install")]).toEqual([name, true]);
    expect([name, built.cache.find((event) => event.kind === "deps-plan")?.status]).toEqual([name, "miss"]);
  }
  // The local index is read through the same validator, so a poisoned record there is also a miss.
  const local = join(root, "poisoned-local");
  await build({ ...options, cacheDir: local, output: join(root, "poisoned-local-cold") });
  const planFile = join(local, "plans/deps", (await readdir(join(local, "plans/deps")))[0]!);
  const stored = JSON.parse(await readFile(planFile, "utf8"));
  const storedTarget = Object.keys(stored.aliases)[0]!;
  await writeFile(planFile, canonicalJSON({ ...stored, aliases: { ...stored.aliases, [storedTarget]: [{ ...stored.aliases[storedTarget][0], target: "/etc/passwd" }] } }));
  const poisonedLocal = recorder();
  const localResult = await build({ ...options, ...poisonedLocal.options, registryCache: false, cacheDir: local, output: join(root, "poisoned-local-warm") });
  expect(poisonedLocal.state.log).not.toContain("Reusing dependency closure");
  expect(poisonedLocal.state.phases()).toContain("install");
  expect(localResult.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "invalid-or-unavailable" });
}, 120_000);

test("only the local cache disabled still consults no plan, and one unusable source does not hide another", async () => {
  const root = await fixture(), { f, mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  // The flag exists to force a clean local flow, and a plan hit has no local index to be written
  // through to, so a warm registry must not shortcut it.
  const clean = recorder();
  mock.requests.length = 0;
  const result = await build({ ...options, ...clean.options, localCache: false, cacheWrite: false, installCache: f.cache, output: join(root, "clean") });
  expect(clean.state.log).not.toContain("Reusing dependency closure");
  expect(clean.state.phases()).toContain("install");
  const bypassed = result.cache.filter((event) => event.kind === "deps-plan");
  expect(bypassed).toHaveLength(1);
  expect(bypassed[0]).toMatchObject({ status: "bypass", reason: "disabled" });
  // Not merely unused: with no write path to account for, the plan tag is never touched at all,
  // so a warm registry costs a clean local flow nothing.
  expect(mock.requests.filter((request) => request.url.pathname.includes("bunko-cache-v1-deps-plan-"))).toHaveLength(0);
  // Reads stay enabled under cache-write=false, so a suppressed lookup is the only explanation.
  expect(mock.requests.some((request) => request.url.pathname.includes("bunko-cache-v1-deps-"))).toBe(true);
  // A first source whose plan validates but names a closure layer nobody has must not end the search.
  const stale = new MockRegistry(), { tagKey, manifest, record } = planArtifact(mock);
  const orphan = canonicalJSON({ ...record, key: `sha256:${"1".repeat(64)}` }), tag = tagKey.slice(repo.length + 1);
  stale.blobs.set(`stale.test/cache/${sha256(orphan)}`, orphan);
  stale.manifests.set(`stale.test/cache/${tag}`, { bytes: canonicalJSON({ ...manifest, config: { mediaType: manifest.config.mediaType, digest: sha256(orphan), size: orphan.length } }), type: media.manifest });
  const both = { credentials: async () => undefined, fetcher: async (input: string | URL, init?: RequestInit) =>
    new URL(input).host === "stale.test" ? stale.fetch(input, init) : mock.fetch(input, init) };
  const ordered = recorder();
  const second = await build({ ...options, ...ordered.options, registry: both, cacheFrom: ["stale.test/cache"],
    cacheDir: join(root, "ordered"), output: join(root, "ordered-image") });
  expect(ordered.state.log).toContain("Reusing dependency closure (amd64) from registry plan");
  expect(ordered.state.phases()).not.toContain("install");
  expect(second.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "registry", source: repo });
}, 60_000);

test("sources naming the same closure layer resolve it once", async () => {
  const root = await fixture(), { f, mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  // Two sources, each holding the same plan, and neither holding the layer it names: the second
  // candidate must reuse the first candidate's outcome instead of repeating its lookup.
  const { tagKey, manifest, record } = planArtifact(mock), tag = tagKey.slice(repo.length + 1);
  const config = canonicalJSON(record), hosts = ["first.test", "second.test"];
  const sources = new Map(hosts.map((host) => {
    const registry = new MockRegistry();
    registry.blobs.set(`${host}/cache/${sha256(config)}`, config);
    registry.manifests.set(`${host}/cache/${tag}`, { bytes: canonicalJSON({ ...manifest, config: { mediaType: manifest.config.mediaType, digest: sha256(config), size: config.length } }), type: media.manifest });
    return [host, registry];
  }));
  const registry = { credentials: async () => undefined, fetcher: async (input: string | URL, init?: RequestInit) => sources.get(new URL(input).host)!.fetch(input, init) };
  const shared = recorder();
  const result = await build({ path: f.source, baseLayout: options.baseLayout, push: false, gitMetadata: false, installCache: f.cache,
    depsStrategy: "closure", registry, cacheFrom: hosts.map((host) => `${host}/cache`), ...shared.options,
    cacheDir: join(root, "shared"), output: join(root, "shared-image") });
  expect(result.cache.filter((event) => event.kind === "deps")).toHaveLength(1);
  expect(result.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss" });
  expect(shared.state.phases()).toContain("install");
}, 60_000);

test("an unvalidated field on an otherwise valid plan is stripped, never replayed or re-serialised", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  const { tagKey, record } = planArtifact(mock);
  // Cheap to write and well under the 8 MiB metadata limit, but deep enough that re-serialising it
  // overflows the stack. Validation must not carry it out of the parsed object.
  const depth = 100_000, nested = `${"[".repeat(depth)}"leaf"${"]".repeat(depth)}`;
  const poisoned = JSON.stringify(record).replace(/^\{/, `{"extra":${nested},`);
  expect(poisoned.length).toBeLessThan(cacheMetadataLimit);
  expect(() => canonicalJSON(JSON.parse(poisoned))).toThrow();
  reseed(mock, tagKey, Buffer.from(poisoned));
  const guarded = recorder(), fresh = join(root, "deep");
  const result = await build({ ...options, ...guarded.options, cacheDir: fresh, output: join(root, "deep-image") });
  // The record is otherwise sound, so the closure is still reused; what must not happen is a build
  // failure, or the extra field reaching the local index or the published artifact.
  expect(guarded.state.log).toContain("Reusing dependency closure (amd64) from registry plan");
  expect(result.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "registry" });
  const stored = JSON.parse(await readFile(join(fresh, "plans", "deps", `${record.planKey.slice(7)}.json`), "utf8"));
  expect(Object.keys(stored).sort()).toEqual(Object.keys(record).sort());
  expect(Buffer.from(canonicalJSON(stored))).toEqual(Buffer.from(canonicalJSON(record)));
  expect(result.cacheExports!.filter((entry) => entry.kind === "deps-plan").every((entry) => entry.status !== "failed")).toBe(true);
}, 60_000);

test("a stalled plan manifest body is a miss within the idle timeout, not a hung build", async () => {
  const root = await fixture(), { f, mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  const tag = planKeys(mock)[0]!.slice(repo.length + 1);
  let stalls = 0;
  const stalling = { credentials: async () => undefined, bodyIdleTimeoutMs: 250, retries: 0, sleep: async () => {},
    fetcher: async (input: string | URL, init?: RequestInit) => {
      // 200 with headers, then a body that never produces a chunk and never ends.
      if (new URL(input).pathname.endsWith(`/manifests/${tag}`) && (init?.method ?? "GET") === "GET") {
        stalls++;
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "Content-Type": media.manifest } });
      }
      return mock.fetch(input, init);
    } };
  const stalled = recorder(), started = performance.now();
  const result = await build({ ...options, ...stalled.options, registry: stalling, cacheDir: join(root, "stalled"), output: join(root, "stalled-image") });
  expect(stalls).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(30_000);
  expect(stalled.state.phases()).toContain("install");
  expect(result.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "invalid-or-unavailable" });
  expect(f.source).toBeTruthy();
}, 60_000);

test("a plan whose artifact is malformed or whose registry errors is a miss on every shape", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "cold") });
  const { tagKey, manifest, record } = planArtifact(mock), config = canonicalJSON(record);
  const shapes: Record<string, unknown> = {
    // The kind annotation is what separates a plan artifact from a layer artifact.
    annotations: { ...manifest, annotations: { ...manifest.annotations, "org.bunko.cache.kind": "deps" } },
    // A layer artifact's config type must never be read as a plan.
    "config-type": { ...manifest, config: { ...manifest.config, mediaType: "application/vnd.bunko.cache.config.v1+json" } },
    layers: { ...manifest, layers: [] },
  };
  for (const [name, replacement] of Object.entries(shapes)) {
    mock.blobs.set(`${repo}/${sha256(config)}`, config);
    mock.manifests.set(tagKey, { bytes: canonicalJSON(replacement), type: media.manifest });
    const run = recorder();
    const result = await build({ ...options, ...run.options, cacheDir: join(root, name), output: join(root, `${name}-image`) });
    expect([name, run.state.phases().includes("install")]).toEqual([name, true]);
    expect([name, result.cache.find((event) => event.kind === "deps-plan")?.reason]).toEqual([name, "invalid-or-unavailable"]);
  }
  // A non-404 registry answer is unavailability, not an absent plan.
  const failing = { credentials: async () => undefined, retries: 0, sleep: async () => {},
    fetcher: async (input: string | URL, init?: RequestInit) =>
      new URL(input).pathname.endsWith(`/manifests/${tagKey.slice(repo.length + 1)}`) ? new Response(null, { status: 500 }) : mock.fetch(input, init) };
  const errored = recorder();
  const result = await build({ ...options, ...errored.options, registry: failing, cacheDir: join(root, "errored"), output: join(root, "errored-image") });
  expect(errored.state.phases()).toContain("install");
  expect(result.cache.find((event) => event.kind === "deps-plan")).toMatchObject({ status: "miss", reason: "invalid-or-unavailable" });
}, 90_000);

test("a local plan whose layer was pruned falls through to the registry plan", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  const cacheDir = join(root, "cache");
  const first = await build({ ...options, cacheDir, output: join(root, "cold") });
  // The local index still names a closure layer the local cache no longer has.
  const planFile = join(cacheDir, "plans/deps", (await readdir(join(cacheDir, "plans/deps")))[0]!);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  await rm(join(cacheDir, "keys", "deps", `${plan.key.slice(7)}.json`));
  const warm = recorder();
  const second = await build({ ...options, ...warm.options, cacheDir, output: join(root, "warm") });
  expect(warm.state.log).toContain("Reusing dependency closure (amd64)");
  expect(warm.state.phases()).not.toContain("install");
  expect(second.cache.find((event) => event.kind === "deps")).toMatchObject({ status: "registry" });
  expect(second.images[0]!.closure).toEqual(first.images[0]!.closure);
}, 60_000);

test("remote prune enumerates and deletes plan artifacts under the same rules as layer artifacts", async () => {
  const root = await fixture(), { mock, options } = await setup(root);
  await build({ ...options, cacheDir: join(root, "cache"), output: join(root, "image") });
  const tags = [...mock.manifests.keys()].filter((key) => key.startsWith(`${repo}/bunko-cache-v1-`)).map((key) => key.slice(repo.length + 1));
  expect(tags.filter((tag) => tag.startsWith("bunko-cache-v1-deps-plan-"))).toHaveLength(1);
  const deletes: string[] = [];
  const registry = { credentials: async () => undefined, fetcher: async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/tags/list")) return Response.json({ tags: ["latest", ...tags] });
    if (init?.method === "DELETE") { deletes.push(url.pathname); return new Response(null, { status: 202 }); }
    return mock.fetch(input, init);
  } };
  const preview = await pruneRegistry(repo, false, registry);
  expect(preview.tags.map((item) => item.tag)).toEqual([...tags].sort());
  expect(deletes).toHaveLength(0);
  const executed = await pruneRegistry(repo, true, registry);
  expect(executed.deleted).toEqual([...tags].sort());
  expect(deletes.some((path) => path.includes("bunko-cache-v1-deps-plan-"))).toBe(true);
}, 30_000);
