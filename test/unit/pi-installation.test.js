import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { isCompiledPi, livePiLaunch, locatePiPackages, piCliEntry } from "../../scripts/lib/pi-installation.js";

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

test("locates an npm CLI in dist/bundle without accepting an unrelated manifest", { skip: process.platform === "win32" }, async () => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-installation-bundle-"));
  const codingAgent = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  const bin = join(prefix, "bin");
  const entry = join(codingAgent, "dist", "bundle", "cli.js");
  const originalPath = process.env.PATH;
  try {
    await Promise.all([bin, dirname(entry), join(codingAgent, "node_modules", "@earendil-works", "pi-ai"), join(codingAgent, "node_modules", "typebox")]
      .map((path) => mkdir(path, { recursive: true })));
    await writeFile(entry, "#!/usr/bin/env node\n", { mode: 0o700 });
    await symlink(entry, join(bin, "pi"));
    await writeFile(join(codingAgent, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" } }));
    await writeFile(join(codingAgent, "dist", "package.json"), JSON.stringify({ name: "unrelated" }));
    await writeFile(join(codingAgent, "node_modules", "@earendil-works", "pi-ai", "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
    await writeFile(join(codingAgent, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox" }));
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    assert.equal(locatePiPackages().codingAgent, realpathSync(codingAgent));
    assert.equal(piCliEntry(), realpathSync(entry));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(prefix, { recursive: true, force: true });
  }
});

test("an npm shim resolves even though it is not a shebang script", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-installation-shim-"));
  const codingAgent = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  const shim = join(prefix, "pi");
  const originalPath = process.env.PATH;
  try {
    await Promise.all([codingAgent, join(codingAgent, "node_modules", "@earendil-works", "pi-ai"), join(codingAgent, "node_modules", "typebox")]
      .map((path) => mkdir(path, { recursive: true })));
    // npm generates a .cmd batch shim on Windows. Classifying "not a shebang" as
    // a compiled binary would reject every Windows npm development host.
    await writeFile(shim, "@ECHO off\r\nSETLOCAL\r\n", { mode: 0o700 });
    await chmod(shim, 0o700);
    await writeFile(join(codingAgent, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } }));
    await writeFile(join(codingAgent, "node_modules", "@earendil-works", "pi-ai", "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
    await writeFile(join(codingAgent, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox" }));
    process.env.PATH = `${prefix}${delimiter}${originalPath ?? ""}`;
    assert.equal(isCompiledPi(shim), false);
    assert.ok(locatePiPackages().codingAgent.endsWith(join("@earendil-works", "pi-coding-agent")));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(prefix, { recursive: true, force: true });
  }
});

test("live launches disable ambient resources while retaining explicit package and tool selection", () => {
  const original = process.env.PI_CLAUDE_CODE_PROVIDER_PI_BIN;
  try {
    // Use an existing executable; this test checks argv without launching Pi.
    process.env.PI_CLAUDE_CODE_PROVIDER_PI_BIN = process.execPath;
    const launch = livePiLaunch(["-e", "/fixture/provider", "--tools", "read,write"]);
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [
      "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
      "-e", "/fixture/provider", "--tools", "read,write",
    ]);
  } finally {
    if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PI_BIN;
    else process.env.PI_CLAUDE_CODE_PROVIDER_PI_BIN = original;
  }
});

test("compiled Pi binaries are recognized by executable magic on every target", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-installation-magic-"));
  try {
    const cases = [
      ["elf", "7f454c4602010100"],
      ["macho-arm64", "cffaedfe0c000001"],
      ["macho-universal", "cafebabe00000002"],
      ["pe", "4d5a90000300"],
    ];
    for (const [name, hex] of cases) {
      const path = join(prefix, name);
      await writeFile(path, Buffer.from(hex, "hex"));
      assert.equal(isCompiledPi(path), true, name);
    }
    assert.equal(isCompiledPi(join(prefix, "absent")), false);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});
