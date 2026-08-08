"use strict";

const { writeSync } = require("node:fs");
const retrySlot = new Int32Array(new SharedArrayBuffer(4));

// Test-only: some restricted sandboxes lose buffered stdout/stderr from a
// nested Node child even when it exits successfully. Synchronous fd writes
// keep fixture protocol output observable without changing production behavior.
function writeAll(descriptor, chunk, encoding) {
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
  for (let offset = 0; offset < buffer.length;) {
    try {
      offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error?.code !== "EAGAIN") throw error;
      // Child-process pipes are non-blocking. Let the parent drain a full pipe
      // before retrying so large fixture responses are neither truncated nor lost.
      Atomics.wait(retrySlot, 0, 0, 1);
    }
  }
}

function installSynchronousWrite(stream, descriptor) {
  stream.write = (chunk, encoding, callback) => {
    writeAll(descriptor, chunk, encoding);
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") process.nextTick(done);
    return true;
  };
}

installSynchronousWrite(process.stdout, 1);
installSynchronousWrite(process.stderr, 2);
