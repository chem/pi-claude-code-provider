import assert from "node:assert/strict";
import test from "node:test";
import { PI_PEERS, dependencyPolicyErrors } from "../../scripts/lib/dependency-policy.js";

function validManifest() {
  return {
    peerDependencies: Object.fromEntries(PI_PEERS.map((name) => [name, "*"])),
    peerDependenciesMeta: Object.fromEntries(PI_PEERS.map((name) => [name, { optional: true }])),
  };
}

test("accepts only optional Pi-owned peers", () => {
  assert.deepEqual(dependencyPolicyErrors(validManifest()), []);
});

test("rejects every unsupported dependency-policy shape", () => {
  const cases = [
    [{ ...validManifest(), dependencies: { lodash: "*" } }, /must not declare dependencies/],
    [{ ...validManifest(), devDependencies: { typescript: "*" } }, /must not declare devDependencies/],
    [(() => {
      const manifest = validManifest();
      manifest.peerDependenciesMeta.typebox.optional = false;
      return manifest;
    })(), /must be optional/],
    [(() => {
      const manifest = validManifest();
      manifest.peerDependencies.lodash = "*";
      manifest.peerDependenciesMeta.lodash = { optional: true };
      return manifest;
    })(), /Unexpected peer dependency: lodash@\*/],
    [(() => {
      const manifest = validManifest();
      manifest.peerDependencies.typebox = "^1.0.0";
      return manifest;
    })(), /Unexpected peer dependency: typebox@\^1\.0\.0/],
    [(() => {
      const manifest = validManifest();
      delete manifest.peerDependencies.typebox;
      return manifest;
    })(), /Missing Pi peer dependency: typebox/],
  ];
  for (const [manifest, expected] of cases) {
    assert.match(dependencyPolicyErrors(manifest).join("\n"), expected);
  }
});
