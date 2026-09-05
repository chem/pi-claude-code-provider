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
  // Use literals, not the constants: this covers the mechanism, and the two
  // constants are independent by design. Reading them here would make the test
  // change meaning whenever either moves, which is how it broke once already.
  const below = versionStatus("Claude Code", "2.1.241", "2.1.241", "2.1.261");
  assert.equal(below.isVerified, true, "a version can be the tested baseline and still below the floor");
  assert.equal(below.meetsMinimum, false);
  assert.equal(below.minimum, "2.1.261");
  // A floor is advisory: it never becomes the platform advisory's warning.
  assert.equal(below.warning, undefined);
  // Above the baseline yet below the floor, and the reverse, are both possible.
  assert.equal(versionStatus("Pi", "0.85.0", "0.84.2", "0.85.1").meetsMinimum, false);
  assert.equal(versionStatus("Pi", "0.86.0", "0.85.1", "0.85.1").meetsMinimum, true);
  assert.equal(versionStatus("Pi", "0.85.1", "0.85.1", "0.85.1").meetsMinimum, true, "exactly at the floor passes");
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
  const status = Object.freeze(platformStatus("linux", "arm64"));
  for (const value of ["", "1", "true", "*", "linux/x64", "linux/arm64 "]) {
    assert.equal(startupPlatformWarning(status, value), status.warning);
  }
  assert.equal(startupPlatformWarning(status, "linux/arm64"), undefined);
  assert.equal(status.isVerified, false);
  assert.match(status.warning, /compatibility candidate/);
  assert.equal(startupPlatformWarning(platformStatus("win32", "arm64"), "linux/arm64"), platformStatus("win32", "arm64").warning);
  assert.equal(startupPlatformWarning(platformStatus("win32", "x64"), ""), undefined);
});

test("reports verified and candidate platforms accurately", () => {
  assert.equal(platformStatus("linux", "x64", "6.6.87.2-microsoft-standard-WSL2", "Ubuntu-26.04").isVerified, true);
  assert.equal(platformStatus("linux", "x64", "6.8.0-generic").isVerified, false);
  assert.equal(platformStatus("linux", "arm64", "6.6-microsoft-standard-WSL2", "Ubuntu").isVerified, false);
  // macOS is verified by platform, not by architecture: an Intel Mac takes the
  // same code path, so a per-arch split would warn without a reason to.
  for (const architecture of ["arm64", "x64"]) {
    const macos = platformStatus("darwin", architecture);
    assert.equal(macos.isVerified, true);
    assert.equal(macos.warning, undefined);
    assert.match(macos.verified, /macOS\/darwin/);
  }
  const windows = platformStatus("win32", "x64");
  assert.equal(windows.isVerified, true);
  assert.equal(windows.warning, undefined);
  assert.match(windows.verified, /native Windows\/win32-x64/);
  assert.match(platformStatus("win32", "arm64").warning, /unverified.*baseline is x64/);
});
