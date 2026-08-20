import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSchema3BundleSummary,
  renderSchema3BundleSummary,
} from "../../src/fault-affinity/schema3-summary.mjs";

function identity(id) {
  return {
    version: 1,
    id,
    label: `${id} label`,
    risk: "standard",
    digest: id === "measured" ? "a".repeat(64) : "b".repeat(64),
  };
}

function evidence(category = "pass", label = "exit-zero") {
  return { outcome: { validOutcome: true, category, label } };
}

function exactPhase(envelopes, cpus = [2, 3], totalAttempts = 4) {
  return {
    manifest: { schedule: { cpus } },
    envelopes,
    progress: {
      status: envelopes.length === totalAttempts ? "complete"
        : envelopes.length === 0 ? "empty" : "incomplete",
      complete: envelopes.length === totalAttempts,
      committedAttempts: envelopes.length,
      totalAttempts,
    },
  };
}

function baseBundle(version) {
  return {
    manifest: {
      version,
      bundleGeneration: "c".repeat(32),
      workload: identity("measured"),
      ...(version === 5 ? { auxiliaryWorkload: identity("condition") } : {}),
    },
    manifestBinding: { sha256: "d".repeat(64), bytes: 100 },
  };
}

test("a version-5 summary keeps complete A1/B/A2 and per-CPU outcomes distinct", () => {
  const bundle = {
    ...baseBundle(5),
    controlledLoad: {
      manifest: {
        execution: { targetCpu: 2, workerCpus: [0, 1] },
        schedule: {
          legs: [
            { leg: "a1", condition: "without-load" },
            { leg: "b", condition: "with-load" },
            { leg: "a2", condition: "after-recovery" },
          ],
          attemptsPerLeg: 1,
          warmupMs: 10,
          recoveryMs: 20,
        },
      },
      envelope: {
        legs: [
          { leg: "a1", condition: "without-load", attempts: [{ evidence: evidence() }] },
          { leg: "b", condition: "with-load", attempts: [{
            evidence: evidence("target-fault", "signal-SIGSEGV"),
          }] },
          { leg: "a2", condition: "after-recovery", attempts: [{ evidence: evidence() }] },
        ],
      },
      progress: {
        status: "complete",
        complete: true,
        committedSessions: 1,
        totalSessions: 1,
      },
    },
    exactCpu: exactPhase([
      { slot: { cpu: 2 }, attempt: { evidence: evidence() } },
      { slot: { cpu: 3 }, attempt: {
        evidence: evidence("target-fault", "signal-SIGSEGV"),
      } },
    ]),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.bundle.manifestVersion, 5);
  assert.equal(summary.conditionWorkload.id, "condition");
  assert.equal(summary.phases.baseline.status, "not-bound");
  assert.deepEqual(summary.phases.controlledLoad.legs[1].outcomes, [{
    category: "target-fault",
    label: "signal-SIGSEGV",
    count: 1,
  }]);
  assert.equal(summary.phases.exactCpu.status, "incomplete");
  assert.equal(summary.phases.exactCpu.cpus[0].committedAttempts, 1);
  assert.equal(Object.isFrozen(summary.phases.controlledLoad.legs), true);
  assert.match(renderSchema3BundleSummary(summary), /leg b condition=with-load.*target-fault/);
});

test("a version-4 summary groups baseline, topology, and pinned outcomes", () => {
  const pass = evidence();
  const bundle = {
    ...baseBundle(4),
    baseline: {
      manifest: {},
      envelopes: [{ attempts: [{ attempt: { evidence: pass } }] }],
      progress: {
        status: "complete", complete: true,
        committedWaves: 1, totalWaves: 1,
        committedAttempts: 1, totalAttempts: 1,
      },
    },
    groups: {
      manifest: { topology: { contexts: [{
        id: "all", kind: "uniform", cpus: [0, 1], childrenPerWave: 1,
      }] } },
      envelopes: [{
        wave: { contextId: "all" },
        attempts: [{ attempt: { evidence: pass } }],
      }],
      progress: {
        status: "complete", complete: true,
        committedWaves: 1, totalWaves: 1,
        committedAttempts: 1, totalAttempts: 1,
      },
    },
    pinnedConcurrent: {
      manifest: { topology: { contexts: [{
        id: "active", kind: "subset", cpus: [1], cluster: "l2:1", controllerCpu: 0,
      }] } },
      envelopes: [{
        wave: { contextId: "active" },
        attempts: [{ attempt: { evidence: pass } }],
      }],
      progress: {
        status: "complete", complete: true,
        committedWaves: 1, totalWaves: 1,
        committedAttempts: 1, totalAttempts: 1,
      },
    },
    exactCpu: exactPhase([
      { slot: { cpu: 2 }, attempt: { evidence: pass } },
    ], [2], 1),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.phases.baseline.committedAttempts, 1);
  assert.equal(summary.phases.groups.contexts[0].id, "all");
  assert.equal(summary.phases.pinnedConcurrent.contexts[0].controllerCpu, 0);
  assert.equal(summary.phases.controlledLoad.status, "not-bound");
  assert.match(renderSchema3BundleSummary(summary), /context active controller=0/);
});

test("summaries reject unsupported manifests and invalid committed outcomes", () => {
  assert.throws(() => buildSchema3BundleSummary({
    ...baseBundle(6),
    exactCpu: exactPhase([]),
  }), /manifest version is unsupported/);
  assert.throws(() => buildSchema3BundleSummary({
    ...baseBundle(1),
    exactCpu: exactPhase([{
      slot: { cpu: 2 },
      attempt: { evidence: { outcome: { validOutcome: false } } },
    }]),
  }), /invalid outcome evidence/);
});
