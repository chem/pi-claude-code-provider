import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_MODEL_FAMILIES, MINIMUM_VERSIONS, VERIFIED_VERSIONS, platformStatus, startupPlatformWarning, versionStatus } from "../../src/compatibility.ts";

test("verified versions report verified status without a warning", () => {
  const status = versionStatus("Pi", VERIFIED_VERSIONS.pi, VERIFIED_VERSIONS.pi);
  assert.equal(status.isVerified, true);
  assert.equal(status.warning, undefined);
});

test("targets a model family for every picker alias, not a dated model id", () => {
  assert.deepEqual(Object.keys(EXPECTED_MODEL_FAMILIES), ["sonnet", "fable", "opus", "haiku"]);
  // A point release that renames the served model must not fail the paid gate,
  // but an alias serving the wrong family still must.
  assert.match("claude-opus-5", EXPECTED_MODEL_FAMILIES.opus);
  assert.match("claude-opus-6-20270101", EXPECTED_MODEL_FAMILIES.opus);
  assert.doesNotMatch("claude-sonnet-5", EXPECTED_MODEL_FAMILIES.opus);
  assert.match("claude-fable-5-1", EXPECTED_MODEL_FAMILIES.fable);
  assert.match("claude-haiku-4-5-20251001", EXPECTED_MODEL_FAMILIES.haiku);
});

test("a supported-version floor is reported separately from the tested baseline", () => {
  // The two constants are independent by design and today the floor is higher,
  // so a version can be below the minimum and above the baseline at once.
  const below = versionStatus("Claude Code", "2.1.241", VERIFIED_VERSIONS.claudeCode, MINIMUM_VERSIONS.claudeCode);
  assert.equal(below.isVerified, true);
  assert.equal(below.meetsMinimum, false);
  assert.equal(below.minimum, MINIMUM_VERSIONS.claudeCode);
  // A floor is advisory: it never becomes the platform advisory's warning.
  assert.equal(below.warning, undefined);
  assert.equal(versionStatus("Claude Code", "2.1.261", VERIFIED_VERSIONS.claudeCode, MINIMUM_VERSIONS.claudeCode).meetsMinimum, true);
  assert.equal(versionStatus("Pi", "0.85.0", VERIFIED_VERSIONS.pi, MINIMUM_VERSIONS.pi).meetsMinimum, false);
  assert.equal(versionStatus("Pi", "0.86.0", VERIFIED_VERSIONS.pi, MINIMUM_VERSIONS.pi).meetsMinimum, true);
  // Omitting the minimum omits both fields rather than defaulting them.
  const unbounded = versionStatus("Pi", "0.1.0", VERIFIED_VERSIONS.pi);
  assert.equal("minimum" in unbounded, false);
  assert.equal("meetsMinimum" in unbounded, false);
});

test("untested versions remain identifiable without a startup warning", () => {
  const status = versionStatus("Claude Code", "99.0.0", VERIFIED_VERSIONS.claudeCode);
  assert.equal(status.isVerified, false);
  assert.equal(status.current, "99.0.0");
  assert.equal(status.verified, VERIFIED_VERSIONS.claudeCode);
  assert.equal(status.warning, undefined);
});

test("startup platform acknowledgement is exact and preserves diagnostic metadata", () => {
  // Acknowledgement only means anything on a platform that still carries an
  // advisory, so name one rather than whichever platform is verified today.
  const status = Object.freeze(platformStatus("darwin", "x64"));
  for (const value of ["", "1", "true", "*", "darwin/arm64", "darwin/x64 "]) {
    assert.equal(startupPlatformWarning(status, value), status.warning);
  }
  assert.equal(startupPlatformWarning(status, "darwin/x64"), undefined);
  assert.equal(status.isVerified, false);
  assert.match(status.warning, /unverified/);
  assert.equal(startupPlatformWarning(platformStatus("linux", "arm64"), "darwin/x64"), platformStatus("linux", "arm64").warning);
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
