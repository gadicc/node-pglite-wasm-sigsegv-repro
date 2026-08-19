import assert from "node:assert/strict";
import {
  chmodSync,
  fstatSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  BundleExecutionLeaseError,
  assertBundleExecutionLeaseHeld,
  bundleExecutionLeaseAttemptRetention,
  bundleExecutionLeaseEvidence,
  withBundleExecutionLease,
} from "../bundle-execution-lease.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function privateDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "bundle-execution-lease-"));
  directories.push(directory);
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("a bundle execution lease excludes a competing writer and releases exactly once", {
  timeout: 5_000,
}, async () => {
  const bundleDir = privateDirectory();
  const started = deferred();
  const release = deferred();
  let retained;
  const first = withBundleExecutionLease({ bundleDir }, async (lease) => {
    assert.equal(assertBundleExecutionLeaseHeld(lease), true);
    retained = bundleExecutionLeaseAttemptRetention(lease);
    assert.equal(fstatSync(retained.fd, { bigint: true }).ino.toString(), retained.inode);
    const evidence = bundleExecutionLeaseEvidence(lease);
    assert.equal(evidence.directory.inode, retained.inode);
    assert.match(evidence.generation, /^[a-f0-9]{32}$/);
    started.resolve();
    await release.promise;
    return "first-complete";
  });

  await started.promise;
  await assert.rejects(
    withBundleExecutionLease({ bundleDir }, async () => "must-not-run"),
    (error) => error instanceof BundleExecutionLeaseError &&
      error.code === "BUNDLE_EXECUTION_LEASE_BUSY",
  );
  release.resolve();
  assert.equal(await first, "first-complete");
  assert.throws(() => fstatSync(retained.fd), /EBADF/);
  assert.equal(await withBundleExecutionLease({ bundleDir }, async () => "reacquired"),
    "reacquired");
});

test("bounded waiting does not block the event loop that releases the active owner", {
  timeout: 5_000,
}, async () => {
  const bundleDir = privateDirectory();
  const started = deferred();
  const release = deferred();
  const first = withBundleExecutionLease({ bundleDir }, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;

  const waiting = withBundleExecutionLease({ bundleDir, waitMs: 1_000 }, async () => "second");
  setTimeout(() => release.resolve(), 50);
  assert.equal(await waiting, "second");
  await first;
});

test("lease acquisition rejects non-private directories before invoking the operation", async () => {
  const bundleDir = privateDirectory();
  chmodSync(bundleDir, 0o755);
  let invoked = false;
  await assert.rejects(withBundleExecutionLease({ bundleDir }, async () => {
    invoked = true;
  }), BundleExecutionLeaseError);
  assert.equal(invoked, false);
});
