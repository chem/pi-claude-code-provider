// Stage definitions for the subscription-consuming test runner, kept separate
// from the runner so deterministic tests can read them without executing it.

export const PAID_STAGES = {
  smoke: { label: "smoke", cap: 1, script: "live-test.js", args: [] },
  // Pi ships as an npm package and as a compiled standalone binary, and the
  // proposal bridge is spawned differently on each. Both lanes are required.
  bridge: { label: "npm bridge", cap: 3, script: "live-test.js", args: ["--bridge"], toolBearing: true },
  "bridge-standalone": {
    label: "standalone bridge",
    cap: 3,
    script: "live-test.js",
    args: ["--bridge"],
    requiresPiBin: true,
    toolBearing: true,
  },
  full: { label: "full live", cap: 28, script: "live-test.js", args: ["--full"], toolBearing: true },
  "post-tools": { label: "post-tool live", cap: 6, script: "live-test.js", args: ["--post-tools"], toolBearing: true },
  cache: { label: "cache", cap: 3, script: "live-test.js", args: ["--cache"] },
  // Fable 5 availability and included quota vary by subscription tier, so its
  // one-launch case is opt-in and excluded from the blocking gate.
  fable: { label: "fable model", cap: 1, script: "model-matrix.js", args: ["--case", "fable:medium"] },
  opus: { label: "opus model", cap: 1, script: "model-matrix.js", args: ["--case", "opus:medium"] },
  matrix: { label: "model matrix", cap: 20, script: "model-matrix.js", args: [] },
};

export const RELEASE_ORDER = ["full", "cache", "bridge", "bridge-standalone", "matrix"];

/** A tool round trip costs at least two launches: propose, then continue after Pi executes. */
export const MINIMUM_TOOL_BEARING_CAP = 2;

export function releaseCap() {
  return RELEASE_ORDER.reduce((total, name) => total + PAID_STAGES[name].cap, 0);
}
