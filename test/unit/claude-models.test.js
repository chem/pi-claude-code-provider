import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MODEL_ALIASES, clearModelAliasCache, readClaudeModelAliases } from "../../src/claude-models.ts";

// A synthetic table in the shape the scanner parses, written by this test and
// read back by it. These ids are sample values, NOT a pin on what Claude Code
// serves: no test here ever opens the installed binary, so an upstream model
// refresh cannot fail this suite. Do not "update" them to track upstream --
// that would reintroduce exactly the version coupling this project removed when
// EXPECTED_MODEL_FAMILIES replaced dated ids. Change them only to cover a new
// table *shape*.
const ALIAS_TABLE = 'sonnet:{default:"claude-sonnet-5",per_provider:{gateway:"claude-sonnet-4-6"}},'
    + 'opus:{default:"claude-opus-5"},haiku:{default:"claude-haiku-4-5"},'
    + 'fable:{default:"claude-fable-5-1",per_provider:{gateway:"claude-fable-5"}}';

function installation(executable) {
    return { executable, version: "2.1.261", subscriptionType: "pro" };
}

async function scan(directory, contents, name = "claude") {
    const executable = join(directory, name);
    await writeFile(executable, contents);
    clearModelAliasCache();
    return readClaudeModelAliases(installation(executable));
}

test("reads one model per alias and ignores per-provider overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-models-"));
    try {
        // Binary padding around the table: the scan must not depend on the table
        // being text-aligned or near the start of the file.
        const versions = await scan(directory, Buffer.concat([
            Buffer.alloc(4096, 0),
            Buffer.from(`junk ${ALIAS_TABLE} junk`, "latin1"),
            Buffer.alloc(4096, 0xff),
        ]));
        assert.deepEqual(versions, {
            sonnet: "claude-sonnet-5",
            fable: "claude-fable-5-1",
            opus: "claude-opus-5",
            haiku: "claude-haiku-4-5",
        });
        // The gateway values are present in the input and must not be reported;
        // this provider only ever runs firstParty.
        assert.equal(Object.values(versions).includes("claude-sonnet-4-6"), false);
        assert.equal(Object.values(versions).includes("claude-fable-5"), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("finds a table that straddles a read-chunk boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-models-chunk-"));
    try {
        // Land the 1 MiB read boundary in the middle of the opus match itself,
        // not merely somewhere in the table. Without the carried tail this
        // alias is silently lost, so the assertion below is not vacuous.
        const target = ALIAS_TABLE.indexOf('opus:{default:"claude-opus-5"');
        assert.notEqual(target, -1);
        const prefix = 1024 * 1024 - (target + 'opus:{default:"claude'.length);
        const versions = await scan(directory, Buffer.concat([
            Buffer.alloc(prefix, 0x20),
            Buffer.from(ALIAS_TABLE, "latin1"),
        ]));
        assert.equal(versions.sonnet, "claude-sonnet-5");
        assert.equal(versions.opus, "claude-opus-5");
        assert.equal(versions.haiku, "claude-haiku-4-5");
        assert.equal(versions.fable, "claude-fable-5-1");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("treats a second distinct value for an alias as unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-models-ambiguous-"));
    try {
        // Two different values mean the table's shape changed. Reporting a
        // confident wrong version is worse than reporting nothing.
        const versions = await scan(directory, Buffer.from(
            `${ALIAS_TABLE} sonnet:{default:"claude-sonnet-6"} opus:{default:"claude-opus-5"}`,
            "latin1",
        ));
        assert.equal(versions.sonnet, undefined);
        // A repeated identical value is still one answer.
        assert.equal(versions.opus, "claude-opus-5");
        assert.equal(versions.haiku, "claude-haiku-4-5");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("degrades to unavailable rather than failing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-models-soft-"));
    try {
        assert.deepEqual(await scan(directory, Buffer.from("no alias table here", "latin1")), {});
        assert.deepEqual(await scan(directory, Buffer.alloc(0)), {});
        // A truncated table matches nothing rather than half-matching.
        assert.deepEqual(await scan(directory, Buffer.from('sonnet:{default:"claude-', "latin1")), {});
        clearModelAliasCache();
        assert.deepEqual(await readClaudeModelAliases(installation(join(directory, "absent"))), {});
        clearModelAliasCache();
        assert.deepEqual(await readClaudeModelAliases(installation(directory)), {});
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("an exhausted scan budget reports nothing instead of a partial answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-models-budget-"));
    try {
        const executable = join(directory, "claude");
        await writeFile(executable, Buffer.concat([
            Buffer.alloc(4 * 1024 * 1024, 0x20),
            Buffer.from(ALIAS_TABLE, "latin1"),
        ]));
        clearModelAliasCache();
        assert.deepEqual(await readClaudeModelAliases(installation(executable), -1), {});
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("advertises exactly the picker aliases", () => {
    assert.deepEqual([...MODEL_ALIASES], ["sonnet", "fable", "opus", "haiku"]);
});
