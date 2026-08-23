import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { documentationPolicyErrors } from "../../scripts/lib/documentation-policy.js";

test("documentation policy validates local links, anchors, and verified versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-doc-policy-"));
  try {
    const index = join(root, "README.md");
    const target = join(root, "TARGET.md");
    const compatibility = join(root, "DEVELOPING.md");
    await writeFile(index, "[valid](TARGET.md#target-heading) [baseline](DEVELOPING.md#compatibility-baseline) [external](https://example.com)\n");
    await writeFile(target, "# Target heading\n");
    await writeFile(compatibility, "# Compatibility baseline\nVerified: 1.2.3 and 4.5.6\n");
    assert.deepEqual(documentationPolicyErrors(root, [index, target, compatibility], { pi: "1.2.3", claude: "4.5.6" }), []);

    await writeFile(index, "[missing](MISSING.md) [anchor](TARGET.md#missing) [baseline](DEVELOPING.md#compatibility-baseline)\n");
    assert.deepEqual(documentationPolicyErrors(root, [index, target, compatibility], { pi: "1.2.3", claude: "9.9.9" }), [
      "Broken Markdown link in README.md: MISSING.md",
      "Broken Markdown anchor in README.md: TARGET.md#missing",
      "DEVELOPING.md omits verified version 9.9.9",
    ]);

    await writeFile(index, "[baseline](DEVELOPING.md#compatibility-baseline) Verified with 1.2.3 and 4.5.6.\n");
    assert.deepEqual(documentationPolicyErrors(root, [index, target, compatibility], { pi: "1.2.3", claude: "4.5.6" }), [
      "README.md duplicates verified pi version 1.2.3; DEVELOPING.md owns compatibility baselines",
      "README.md duplicates verified claude version 4.5.6; DEVELOPING.md owns compatibility baselines",
    ]);

    await writeFile(index, "Compatibility details moved.\n");
    assert.deepEqual(documentationPolicyErrors(root, [index, target, compatibility], { pi: "1.2.3", claude: "4.5.6" }), [
      "README.md must link to DEVELOPING.md#compatibility-baseline",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
