import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { importedSpecifiers, repositoryFiles } from "../../scripts/lib/source-policy.js";

test("finds static, side-effect, dynamic, and re-exported imports", () => {
  const source = [
    'import "side-effect";',
    'import value from "package";',
    'const lazy = import("dynamic");',
    'export * from "re-export";',
    'export { named } from "named-export";',
    'const text = "import \\"not-a-package\\"";',
    'const pattern = /import "also-not-a-package"/;',
    'loader.import("property-call");',
    'const template = `literal ${await import("template-dynamic")}`;',
    '// import "commented-out"',
  ].join("\n");
  assert.deepEqual(importedSpecifiers(source), [
    "side-effect",
    "package",
    "dynamic",
    "re-export",
    "named-export",
    "template-dynamic",
  ]);
});

test("lists tracked and pending source while excluding ignored files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-source-policy-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: directory }).status, 0);
    await writeFile(join(directory, "tracked.js"), "export {};\n");
    await writeFile(join(directory, "pending.js"), "export {};\n");
    await writeFile(join(directory, "ignored.js"), "invalid generated file\n");
    await writeFile(join(directory, ".gitignore"), "ignored.js\n");
    assert.equal(spawnSync("git", ["add", ".gitignore", "tracked.js"], { cwd: directory }).status, 0);
    assert.deepEqual(repositoryFiles(directory, ["."]).map((path) => path.slice(directory.length + 1)).sort(), [
      ".gitignore",
      "pending.js",
      "tracked.js",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists packed source without Git while excluding installed dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-packed-source-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "src", "provider.ts"), "export {};\n");
    await writeFile(join(directory, "node_modules", "dependency.js"), "invalid generated file\n");
    assert.deepEqual(repositoryFiles(directory, ["."]).map((path) => path.slice(directory.length + 1)), [
      join("src", "provider.ts"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
