import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_MODEL_RESOLUTIONS, VERIFIED_VERSIONS, platformStatus, startupPlatformWarning, versionStatus } from "../../src/compatibility.ts";

test("verified versions report verified status without a warning", () => {
  const status = versionStatus("Pi", VERIFIED_VERSIONS.pi, VERIFIED_VERSIONS.pi);
  assert.equal(status.isVerified, true);
  assert.equal(status.warning, undefined);
});

test("distinguishes the account default from pinned alias compatibility targets", () => {
  assert.deepEqual(Object.keys(EXPECTED_MODEL_RESOLUTIONS), ["default", "sonnet", "fable", "opus", "haiku"]);
  assert.equal(EXPECTED_MODEL_RESOLUTIONS.default, null);
  assert.equal(EXPECTED_MODEL_RESOLUTIONS.opus, "claude-opus-5");
  assert.match(EXPECTED_MODEL_RESOLUTIONS.haiku, /^claude-haiku-/);
});

test("untested versions remain identifiable without a startup warning", () => {
  const status = versionStatus("Claude Code", "99.0.0", VERIFIED_VERSIONS.claudeCode);
  assert.equal(status.isVerified, false);
  assert.equal(status.current, "99.0.0");
  assert.equal(status.verified, VERIFIED_VERSIONS.claudeCode);
  assert.equal(status.warning, undefined);
});

test("startup platform acknowledgement is exact and preserves diagnostic metadata", () => {
  const status = Object.freeze(platformStatus("darwin", "arm64"));
  for (const value of ["", "1", "true", "*", "darwin/x64", "darwin/arm64 "]) {
    assert.equal(startupPlatformWarning(status, value), status.warning);
  }
  assert.equal(startupPlatformWarning(status, "darwin/arm64"), undefined);
  assert.equal(status.isVerified, false);
  assert.match(status.warning, /live validation is pending/);
  assert.equal(startupPlatformWarning(platformStatus("linux", "arm64"), "darwin/arm64"), platformStatus("linux", "arm64").warning);
  assert.equal(startupPlatformWarning(platformStatus("win32", "x64"), ""), undefined);
});

test("reports verified and candidate platforms accurately", () => {
  assert.equal(platformStatus("linux", "x64", "6.6.87.2-microsoft-standard-WSL2", "Ubuntu-26.04").isVerified, true);
  assert.equal(platformStatus("linux", "x64", "6.8.0-generic").isVerified, false);
  assert.equal(platformStatus("linux", "arm64", "6.6-microsoft-standard-WSL2", "Ubuntu").isVerified, false);
  const macos = platformStatus("darwin", "arm64");
  assert.equal(macos.isVerified, true);
  assert.equal(macos.warning, undefined);
  assert.match(macos.verified, /Apple Silicon macOS\/darwin-arm64/);
  assert.match(platformStatus("darwin", "x64").warning, /unverified/);
  const windows = platformStatus("win32", "x64");
  assert.equal(windows.isVerified, true);
  assert.equal(windows.warning, undefined);
  assert.match(windows.verified, /native Windows\/win32-x64/);
  assert.match(platformStatus("win32", "arm64").warning, /unverified.*baseline is x64/);
});
