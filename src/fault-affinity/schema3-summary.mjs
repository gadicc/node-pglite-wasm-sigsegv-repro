export const SCHEMA3_SUMMARY_VERSION = 1;

function fail(message) {
  throw new TypeError(`cannot summarize schema-3 bundle: ${message}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function workloadIdentity(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.version) || typeof value.id !== "string" ||
      typeof value.label !== "string" || typeof value.risk !== "string" ||
      typeof value.digest !== "string") {
    fail(`${label} identity is invalid`);
  }
  return {
    version: value.version,
    id: value.id,
    label: value.label,
    risk: value.risk,
    digest: value.digest,
  };
}

function outcomeRows(evidences) {
  const counts = new Map();
  for (const evidence of evidences) {
    const outcome = evidence?.outcome;
    if (outcome?.validOutcome !== true || typeof outcome.category !== "string" ||
        typeof outcome.label !== "string") {
      fail("committed attempt has invalid outcome evidence");
    }
    const key = `${outcome.category}\0${outcome.label}`;
    const current = counts.get(key);
    if (current === undefined) {
      counts.set(key, { category: outcome.category, label: outcome.label, count: 1 });
    } else {
      current.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) =>
    left.category < right.category ? -1 : left.category > right.category ? 1
      : left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
}

function progress(value, unit) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.status !== "string" || typeof value.complete !== "boolean") {
    fail(`${unit} progress is invalid`);
  }
  const committedKey = unit === "sessions" ? "committedSessions"
    : unit === "waves" ? "committedWaves" : "committedAttempts";
  const totalKey = unit === "sessions" ? "totalSessions"
    : unit === "waves" ? "totalWaves" : "totalAttempts";
  if (!Number.isSafeInteger(value[committedKey]) || value[committedKey] < 0 ||
      !Number.isSafeInteger(value[totalKey]) || value[totalKey] < value[committedKey]) {
    fail(`${unit} progress counts are invalid`);
  }
  return {
    status: value.status,
    complete: value.complete,
    committed: value[committedKey],
    scheduled: value[totalKey],
  };
}

function notBound() {
  return { status: "not-bound", complete: false };
}

function exactSummary(phase) {
  if (phase === undefined) fail("exact-CPU phase is missing");
  const byCpu = new Map(phase.manifest.schedule.cpus.map((cpu) => [cpu, []]));
  const all = [];
  for (const envelope of phase.envelopes) {
    const evidence = envelope.attempt.evidence;
    const entries = byCpu.get(envelope.slot.cpu);
    if (entries === undefined) fail("exact-CPU envelope names an unscheduled CPU");
    entries.push(evidence);
    all.push(evidence);
  }
  return {
    ...progress(phase.progress, "attempts"),
    outcomes: outcomeRows(all),
    cpus: [...byCpu.entries()].map(([cpu, evidences]) => ({
      cpu,
      committedAttempts: evidences.length,
      outcomes: outcomeRows(evidences),
    })),
  };
}

function baselineSummary(phase) {
  if (phase === undefined) return notBound();
  const evidences = phase.envelopes.flatMap((envelope) =>
    envelope.attempts.map((bound) => bound.attempt.evidence));
  return {
    ...progress(phase.progress, "waves"),
    committedAttempts: phase.progress.committedAttempts,
    scheduledAttempts: phase.progress.totalAttempts,
    outcomes: outcomeRows(evidences),
  };
}

function contextSummary(phase, kind) {
  if (phase === undefined) return notBound();
  const contexts = new Map(phase.manifest.topology.contexts.map((context) => [
    context.id,
    {
      id: context.id,
      kind: context.kind,
      cpus: [...context.cpus],
      ...(kind === "pinned" ? {
        cluster: context.cluster,
        controllerCpu: context.controllerCpu,
      } : {}),
      committedWaves: 0,
      committedAttempts: 0,
      evidences: [],
    },
  ]));
  for (const envelope of phase.envelopes) {
    const context = contexts.get(envelope.wave.contextId);
    if (context === undefined) fail(`${kind} envelope names an unknown context`);
    context.committedWaves += 1;
    context.committedAttempts += envelope.attempts.length;
    for (const bound of envelope.attempts) context.evidences.push(bound.attempt.evidence);
  }
  const evidences = [...contexts.values()].flatMap((context) => context.evidences);
  return {
    ...progress(phase.progress, "waves"),
    committedAttempts: phase.progress.committedAttempts,
    scheduledAttempts: phase.progress.totalAttempts,
    outcomes: outcomeRows(evidences),
    contexts: [...contexts.values()].map((context) => ({
      id: context.id,
      kind: context.kind,
      cpus: context.cpus,
      ...(kind === "pinned" ? {
        cluster: context.cluster,
        controllerCpu: context.controllerCpu,
      } : {}),
      committedWaves: context.committedWaves,
      committedAttempts: context.committedAttempts,
      outcomes: outcomeRows(context.evidences),
    })),
  };
}

function controlledLoadSummary(phase) {
  if (phase === undefined) return notBound();
  const legs = phase.envelope === null
    ? phase.manifest.schedule.legs.map((leg) => ({
      leg: leg.leg,
      condition: leg.condition,
      committedAttempts: 0,
      outcomes: [],
    }))
    : phase.envelope.legs.map((leg) => ({
      leg: leg.leg,
      condition: leg.condition,
      committedAttempts: leg.attempts.length,
      outcomes: outcomeRows(leg.attempts.map((bound) => bound.evidence)),
    }));
  return {
    ...progress(phase.progress, "sessions"),
    targetCpu: phase.manifest.execution.targetCpu,
    workerCpus: [...phase.manifest.execution.workerCpus],
    attemptsPerLeg: phase.manifest.schedule.attemptsPerLeg,
    warmupMs: phase.manifest.schedule.warmupMs,
    recoveryMs: phase.manifest.schedule.recoveryMs,
    legs,
  };
}

function debuggerSummary(phase) {
  if (phase === undefined) return notBound();
  const value = phase.progress;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.status !== "string" || typeof value.complete !== "boolean" ||
      !Number.isSafeInteger(value.committedRuns) || value.committedRuns < 0 ||
      !Number.isSafeInteger(value.maxRuns) || value.maxRuns < value.committedRuns ||
      !Number.isSafeInteger(value.capturedRuns) || value.capturedRuns < 0 ||
      !Number.isSafeInteger(value.maxCaptures) || value.maxCaptures < value.capturedRuns) {
    fail("debugger progress is invalid");
  }
  return {
    status: value.status,
    complete: value.complete,
    committed: value.committedRuns,
    scheduled: value.maxRuns,
    captured: value.capturedRuns,
    maxCaptures: value.maxCaptures,
  };
}

export function buildSchema3BundleSummary(bundle) {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle) ||
      bundle.manifest === null || typeof bundle.manifest !== "object") {
    fail("bundle is invalid");
  }
  const version = bundle.manifest.version;
  if (!Number.isSafeInteger(version) || version < 1 || version > 6) {
    fail("manifest version is unsupported");
  }
  const summary = {
    version: SCHEMA3_SUMMARY_VERSION,
    bundle: {
      schema: 3,
      manifestVersion: version,
      generation: bundle.manifest.bundleGeneration,
      manifestBinding: { ...bundle.manifestBinding },
    },
    workload: workloadIdentity(bundle.manifest.workload, "measured workload"),
    ...(version === 5 ? {
      conditionWorkload: workloadIdentity(
        bundle.manifest.auxiliaryWorkload,
        "condition workload",
      ),
    } : {}),
    phases: {
      baseline: baselineSummary(bundle.baseline),
      groups: contextSummary(bundle.groups, "group"),
      pinnedConcurrent: contextSummary(bundle.pinnedConcurrent, "pinned"),
      controlledLoad: controlledLoadSummary(bundle.controlledLoad),
      debugger: debuggerSummary(bundle.debugger),
      exactCpu: exactSummary(bundle.exactCpu),
    },
    interpretation: {
      boundary: "validated-observations-only",
      note: "Outcome counts describe committed workload observations and do not by themselves establish a causal mechanism.",
    },
  };
  return deepFreeze(summary);
}

function outcomesText(rows) {
  return rows.length === 0
    ? "none"
    : rows.map((row) => `${row.category}/${row.label}:${row.count}`).join(", ");
}

function progressText(phase, unit) {
  if (phase.status === "not-bound") return "not bound";
  return `${phase.status}; ${phase.committed}/${phase.scheduled} ${unit}`;
}

export function renderSchema3BundleSummary(summary) {
  if (summary?.version !== SCHEMA3_SUMMARY_VERSION) fail("summary version is unsupported");
  const lines = [
    "Fault Affinity schema-3 evidence summary",
    `bundle: manifest v${summary.bundle.manifestVersion}; generation ${summary.bundle.generation}`,
    `workload: ${summary.workload.id}; risk ${summary.workload.risk}; digest ${summary.workload.digest}`,
  ];
  if (summary.conditionWorkload !== undefined) {
    lines.push(`condition workload: ${summary.conditionWorkload.id}; ` +
      `risk ${summary.conditionWorkload.risk}; digest ${summary.conditionWorkload.digest}`);
  }
  const { baseline, groups, pinnedConcurrent, controlledLoad, exactCpu } = summary.phases;
  const debuggerPhase = summary.phases.debugger;
  lines.push(`baseline: ${progressText(baseline, "waves")}` +
    `${baseline.outcomes === undefined ? "" : `; outcomes ${outcomesText(baseline.outcomes)}`}`);
  lines.push(`groups: ${progressText(groups, "waves")}` +
    `${groups.outcomes === undefined ? "" : `; outcomes ${outcomesText(groups.outcomes)}`}`);
  for (const context of groups.contexts ?? []) {
    lines.push(`  context ${context.id} cpus=${context.cpus.join(",")} ` +
      `waves=${context.committedWaves} attempts=${context.committedAttempts}; ` +
      `outcomes ${outcomesText(context.outcomes)}`);
  }
  lines.push(`pinned-concurrent: ${progressText(pinnedConcurrent, "waves")}` +
    `${pinnedConcurrent.outcomes === undefined
      ? "" : `; outcomes ${outcomesText(pinnedConcurrent.outcomes)}`}`);
  for (const context of pinnedConcurrent.contexts ?? []) {
    lines.push(`  context ${context.id} controller=${context.controllerCpu} ` +
      `cpus=${context.cpus.join(",")} waves=${context.committedWaves} ` +
      `attempts=${context.committedAttempts}; outcomes ${outcomesText(context.outcomes)}`);
  }
  lines.push(`controlled-load: ${progressText(controlledLoad, "sessions")}`);
  for (const leg of controlledLoad.legs ?? []) {
    lines.push(`  leg ${leg.leg} condition=${leg.condition} attempts=${leg.committedAttempts}; ` +
      `outcomes ${outcomesText(leg.outcomes)}`);
  }
  lines.push(`debugger: ${progressText(debuggerPhase, "runs")}` +
    `${debuggerPhase.status === "not-bound"
      ? "" : `; captured ${debuggerPhase.captured}/${debuggerPhase.maxCaptures}`}`);
  lines.push(`exact-CPU: ${progressText(exactCpu, "attempts")}; ` +
    `outcomes ${outcomesText(exactCpu.outcomes)}`);
  for (const cpu of exactCpu.cpus) {
    lines.push(`  cpu ${cpu.cpu}: attempts=${cpu.committedAttempts}; ` +
      `outcomes ${outcomesText(cpu.outcomes)}`);
  }
  lines.push(`interpretation: ${summary.interpretation.note}`);
  return `${lines.join("\n")}\n`;
}
