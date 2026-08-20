import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MINIMUM_TOOL_BEARING_CAP, PAID_STAGES, RELEASE_ORDER, releaseCap } from "../../scripts/lib/paid-stages.js";

const developing = fileURLToPath(new URL("../../DEVELOPING.md", import.meta.url));

test("a tool-bearing stage can afford the launches a tool round trip costs", () => {
    // Proposing a call and continuing after Pi executes it are separate Claude
    // launches, so a one-launch cap fails before the lane can ever pass.
    for (const [name, stage] of Object.entries(PAID_STAGES)) {
        if (!stage.toolBearing) continue;
        assert.ok(
            stage.cap >= MINIMUM_TOOL_BEARING_CAP,
            `${name} round-trips a tool but caps at ${stage.cap}; a tool call needs at least ${MINIMUM_TOOL_BEARING_CAP} launches`,
        );
    }
});

test("documented launch caps match the runner and each other", async () => {
    const rows = [...(await readFile(developing, "utf8")).matchAll(/^\| `npm run test:paid:([a-z-]+)` \| (\d+) \|$/gm)]
        .map(([, name, cap]) => [name, Number(cap)]);
    assert.ok(rows.length > 0, "DEVELOPING.md documents no paid launch caps");
    const documented = new Map(rows);

    // Every stage is documented, and every documented cap is real.
    assert.deepEqual(
        [...documented.keys()].filter((name) => name !== "release").sort(),
        Object.keys(PAID_STAGES).sort(),
    );
    for (const [name, cap] of documented) {
        if (name === "release") continue;
        assert.equal(cap, PAID_STAGES[name].cap, `documented cap for ${name} does not match the runner`);
    }
    // The advertised aggregate must equal what the release order actually sums to,
    // so the maintainer authorizes the number of launches that can really occur.
    assert.equal(documented.get("release"), releaseCap(), "documented release cap does not match the release order");
    assert.deepEqual(RELEASE_ORDER.filter((name) => name in PAID_STAGES), RELEASE_ORDER);
});
