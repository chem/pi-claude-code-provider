import { fileURLToPath } from "node:url";

const synchronousChildStdio = fileURLToPath(new URL("./synchronous-child-stdio.cjs", import.meta.url));

// Use these helpers for test-created Node children. See the preload for why
// buffered child output can become invisible in restricted sandboxes.
export function nodeFixtureSource(body) {
  return `#!/usr/bin/env node
require(${JSON.stringify(synchronousChildStdio)});
${body}
`;
}

export function nodeFixtureArgs(args) {
  return ["--require", synchronousChildStdio, ...args];
}
