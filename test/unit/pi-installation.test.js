import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { locatePiPackages, piCliEntry } from "../../scripts/lib/pi-installation.js";

test("locates Pi packages in the bundled Windows-installer layout", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-installation-layout-"));
  const codingAgent = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  const piAi = join(codingAgent, "node_modules", "@earendil-works", "pi-ai");
  const typebox = join(codingAgent, "node_modules", "typebox");
  const shim = join(prefix, "pi");
  const originalPath = process.env.PATH;
  try {
    await Promise.all([codingAgent, piAi, typebox, join(codingAgent, "dist")].map((path) => mkdir(path, { recursive: true })));
    await writeFile(shim, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(shim, 0o700);
    await writeFile(join(codingAgent, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }));
    await writeFile(join(piAi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
    await writeFile(join(typebox, "package.json"), JSON.stringify({ name: "typebox" }));
    process.env.PATH = `${prefix}${delimiter}${originalPath ?? ""}`;
    const packages = locatePiPackages();
    const canonicalPrefix = dirname(realpathSync(shim));
    assert.deepEqual(packages, {
      codingAgent: join(canonicalPrefix, "node_modules", "@earendil-works", "pi-coding-agent"),
      piAi: join(canonicalPrefix, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"),
      typebox: join(canonicalPrefix, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "typebox"),
    });
    assert.equal(piCliEntry(codingAgent), join(codingAgent, "dist", "cli.js"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(prefix, { recursive: true, force: true });
  }
});
