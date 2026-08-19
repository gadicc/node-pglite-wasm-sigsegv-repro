import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { buildAttemptEvidence } from "../attempt-evidence.mjs";
import { runWorkloadAttempt } from "../attempt-runner.mjs";
import {
  buildBaselinePhaseManifest,
  buildBaselineWaveEnvelope,
  canonicalBaselineWaveEnvelopeLine,
} from "../baseline-phase.mjs";
import {
  BASELINE_PHASE_FILE,
  BaselinePhaseStoreError,
  commitBaselinePhaseWave,
  initializeBaselinePhaseStore,
  readBaselinePhaseStore,
} from "../baseline-phase-store.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function resolvedWorkload() {
  const cwd = temporaryDirectory("baseline-store-workload-");
  return resolveWorkloadSpec({
    version: 1,
    id: "baseline-store-fixture",
    label: "Baseline store fixture",
    description: "Harmless finite process used to validate baseline phase storage.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 2_000, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { baseline: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function manifest(resolved, overrides = {}) {
  return buildBaselinePhaseManifest(resolved, {
    generation: "0123456789abcdef0123456789abcdef",
    childrenPerWave: 2,
    waves: 2,
    ...overrides,
  });
}

async function evidence(resolved) {
  return buildAttemptEvidence(resolved, await runWorkloadAttempt(resolved));
}

test("the baseline store initializes, resumes, and commits an exact whole-wave prefix", {
  timeout: 8_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const stateDir = temporaryDirectory("baseline-store-");
  const attempt = await evidence(resolved);

  const initialized = await initializeBaselinePhaseStore({
    resolved,
    manifest: phase,
    stateDir,
  });
  assert.equal(initialized.progress.status, "empty");
  assert.equal(statSync(path.join(stateDir, BASELINE_PHASE_FILE)).mode & 0o777, 0o600);
  assert.deepEqual((await initializeBaselinePhaseStore({
    resolved,
    manifest: phase,
    stateDir,
  })).manifest, phase);

  const first = buildBaselineWaveEnvelope(resolved, phase, 1, [attempt, attempt]);
  const afterFirst = await commitBaselinePhaseWave({ resolved, envelope: first, stateDir });
  assert.equal(afterFirst.progress.status, "incomplete");
  assert.equal(afterFirst.progress.committedWaves, 1);
  await assert.rejects(
    commitBaselinePhaseWave({ resolved, envelope: first, stateDir }),
    /not the exact next phase wave/,
  );
  const second = buildBaselineWaveEnvelope(resolved, phase, 2, [attempt, attempt]);
  const afterSecond = await commitBaselinePhaseWave({ resolved, envelope: second, stateDir });
  assert.equal(afterSecond.progress.status, "complete");
  assert.equal(afterSecond.progress.committedAttempts, 4);
  assert.deepEqual((await readBaselinePhaseStore({ resolved, stateDir })).envelopes,
    [first, second]);
  await assert.rejects(
    commitBaselinePhaseWave({ resolved, envelope: second, stateDir }),
    /already complete/,
  );
});

test("the baseline store rejects a changed manifest, gaps, and foreign files", {
  timeout: 8_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);
  const attempt = await evidence(resolved);

  const changedDir = temporaryDirectory("baseline-store-changed-");
  await initializeBaselinePhaseStore({ resolved, manifest: phase, stateDir: changedDir });
  await assert.rejects(initializeBaselinePhaseStore({
    resolved,
    manifest: manifest(resolved, { waves: 3 }),
    stateDir: changedDir,
  }), /different manifest/);

  const gapDir = temporaryDirectory("baseline-store-gap-");
  await initializeBaselinePhaseStore({ resolved, manifest: phase, stateDir: gapDir });
  const second = buildBaselineWaveEnvelope(resolved, phase, 2, [attempt, attempt]);
  writeFileSync(path.join(gapDir, "baseline-wave-000000002.json"),
    canonicalBaselineWaveEnvelopeLine(resolved, phase, second), { mode: 0o600 });
  await assert.rejects(readBaselinePhaseStore({ resolved, stateDir: gapDir }),
    /exact contiguous wave-file prefix/);

  const foreignDir = temporaryDirectory("baseline-store-foreign-");
  writeFileSync(path.join(foreignDir, "foreign.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(initializeBaselinePhaseStore({
    resolved,
    manifest: phase,
    stateDir: foreignDir,
  }), /unknown file|manifest is missing/);
});

test("known dead-writer temporaries recover while live-writer temporaries are retained", {
  timeout: 8_000,
}, async () => {
  const resolved = resolvedWorkload();
  const phase = manifest(resolved);

  const deadDir = temporaryDirectory("baseline-store-dead-");
  const deadName = ".baseline-phase.json.99999998.abcdef0123456789.writing.tmp";
  writeFileSync(path.join(deadDir, deadName), "incomplete", { mode: 0o600 });
  const recovered = await initializeBaselinePhaseStore({
    resolved,
    manifest: phase,
    stateDir: deadDir,
  });
  assert.equal(recovered.progress.status, "empty");
  assert.equal(existsSync(path.join(deadDir, deadName)), false);

  const liveDir = temporaryDirectory("baseline-store-live-");
  const liveName =
    `.baseline-phase.json.${process.pid}.0123456789abcdef.writing.tmp`;
  writeFileSync(path.join(liveDir, liveName), "incomplete", { mode: 0o600 });
  await assert.rejects(initializeBaselinePhaseStore({
    resolved,
    manifest: phase,
    stateDir: liveDir,
  }), (error) => error instanceof BaselinePhaseStoreError && /live writer/.test(error.message));
  assert.equal(existsSync(path.join(liveDir, liveName)), true);
  assert.equal(readFileSync(path.join(liveDir, liveName), "utf8"), "incomplete");
});
