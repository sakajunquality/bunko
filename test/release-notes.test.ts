import { expect, test } from "bun:test";

test("release notes select only the exact version and reject missing, duplicate or empty sections", async () => {
  const script = `import sys; sys.path.insert(0, 'scripts')
import importlib.util
spec=importlib.util.spec_from_file_location('notes', 'scripts/release-notes.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.release_notes('# Unreleased\\nfuture\\n# v1.2.3\\nchosen\\n## Fixes\\nfixed\\n# v1.2.2\\nold', 'v1.2.3') == 'chosen\\n## Fixes\\nfixed\\n'
for text in ['# Unreleased\\nfuture', '# v1.2.3\\n', '# v1.2.3\\na\\n# v1.2.3\\nb']:
 try: m.release_notes(text, 'v1.2.3')
 except ValueError: pass
 else: raise AssertionError('accepted invalid section')`;
  const child = Bun.spawn(["python3", "-B", "-c", script], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(child.stderr).text()).toBe(""); expect(await child.exited).toBe(0);
});
