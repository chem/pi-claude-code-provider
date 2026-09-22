import assert from "node:assert/strict";
import test from "node:test";
import register from "../../extensions/pi-hermit-shell-provider.ts";

test("local hermit provider is opt-in and never reads Claude credentials", () => {
  const previousEnabled = process.env.PI_HERMIT_SHELL_PROVIDER_ENABLED;
  const previousPort = process.env.PI_HERMIT_SHELL_PORT;
  const calls = [];
  const pi = { registerProvider(name, config) { calls.push([name, config]); } };
  try {
    delete process.env.PI_HERMIT_SHELL_PROVIDER_ENABLED;
    register(pi);
    assert.equal(calls.length, 0);
    process.env.PI_HERMIT_SHELL_PROVIDER_ENABLED = "1";
    process.env.PI_HERMIT_SHELL_PORT = "18065";
    register(pi);
    assert.equal(calls.length, 1);
    const [name, config] = calls[0];
    assert.equal(name, "hermit-shell");
    assert.equal(config.api, "openai-completions");
    assert.equal(config.baseUrl, "http://127.0.0.1:18065/v1");
    assert.equal(config.apiKey, "local-only");
    assert.deepEqual(config.models.map((m) => m.id), ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]);
    for (const invalid of ["0", "65536", "abc", "-1"]) {
      process.env.PI_HERMIT_SHELL_PORT = invalid;
      assert.throws(() => register(pi), /PI_HERMIT_SHELL_PORT/);
    }
    assert.equal(calls.length, 1);
  } finally {
    if (previousEnabled === undefined) delete process.env.PI_HERMIT_SHELL_PROVIDER_ENABLED;
    else process.env.PI_HERMIT_SHELL_PROVIDER_ENABLED = previousEnabled;
    if (previousPort === undefined) delete process.env.PI_HERMIT_SHELL_PORT;
    else process.env.PI_HERMIT_SHELL_PORT = previousPort;
  }
});
