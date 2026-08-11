// Pure, bounded association of already-validated telemetry sweeps with
// already-validated exact-CPU workload boundaries.  This module does no I/O
// and never grants authority to workload outcomes.

const DIGEST_RE = /^[a-f0-9]{64}$/;
const GENERATION_RE = /^[a-f0-9]{32}$/;
const MAX_RUNS = 20_000_000;

function decimalBigInt(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 32) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function finiteMetric(value) {
  return Number.isFinite(value) ? value : null;
}

function metricValue(rows, keyParts) {
  if (!Array.isArray(rows)) return null;
  const row = rows.find((candidate) => Array.isArray(candidate) &&
    keyParts.every((part, index) => candidate[index] === part));
  return row ? finiteMetric(row[keyParts.length]) : null;
}

function topologyForCpu(metadata, cpu) {
  const discovery = metadata?.discovery;
  const cpuEntry = Array.isArray(discovery?.cpus)
    ? discovery.cpus.find((entry) => entry?.cpu === cpu)
    : null;
  if (!cpuEntry || !Number.isSafeInteger(cpuEntry.package) || !Number.isSafeInteger(cpuEntry.core)) {
    return null;
  }
  const die = Number.isSafeInteger(cpuEntry.die) ? cpuEntry.die : null;
  const coreTarget = Array.isArray(discovery?.temperature_targets?.cores)
    ? discovery.temperature_targets.cores.find((entry) => entry?.package === cpuEntry.package &&
      entry?.die === die && entry?.core === cpuEntry.core &&
      Array.isArray(entry.logical_cpus) && entry.logical_cpus.includes(cpu))
    : null;
  const packageTarget = Array.isArray(discovery?.temperature_targets?.packages)
    ? discovery.temperature_targets.packages.find((entry) => entry?.package === cpuEntry.package)
    : null;
  return {
    cpu,
    package: cpuEntry.package,
    die,
    core: cpuEntry.core,
    logicalCpus: coreTarget?.logical_cpus ?? [cpu],
    scalingCurFreqSource: cpuEntry.scaling_cur_freq,
    coreTemperatureSensor: typeof coreTarget?.sensor === "string" ? coreTarget.sensor : null,
    coreTemperatureState: typeof coreTarget?.sensor === "string" ? null : coreTarget?.sensor ?? null,
    packageTemperatureSensor: typeof packageTarget?.sensor === "string" ? packageTarget.sensor : null,
    packageTemperatureState: typeof packageTarget?.sensor === "string" ? null : packageTarget?.sensor ?? null,
  };
}

function metricsForSample(sample, topology, cpu) {
  return {
    targetFrequencyKHz: metricValue(
      sample?.scalingCurFreqKHz ?? sample?.scaling_cur_freq_khz,
      [cpu],
    ),
    physicalCoreTemperatureMillicelsius: topology === null
      ? null
      : metricValue(
        sample?.coreTemperatureMillicelsius ?? sample?.core_temperature_millicelsius,
        [topology.package, topology.die, topology.core],
      ),
    packageTemperatureMillicelsius: topology === null
      ? null
      : metricValue(
        sample?.packageTemperatureMillicelsius ?? sample?.package_temperature_millicelsius,
        [topology.package],
      ),
  };
}

function summarizeValues(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { runsWithValue: 0, observations: 0, min: null, max: null, meanOfRunMeans: null };
  let min = finite[0];
  let max = finite[0];
  let sum = 0;
  for (const value of finite) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return {
    runsWithValue: finite.length,
    observations: finite.length,
    min,
    max,
    meanOfRunMeans: sum / finite.length,
  };
}

const METRIC_NAMES = [
  "targetFrequencyKHz",
  "physicalCoreTemperatureMillicelsius",
  "packageTemperatureMillicelsius",
];

function summarizePeriod(records, period) {
  return Object.fromEntries(METRIC_NAMES.map((metric) => {
    if (period === "pre") {
      return [metric, summarizeValues(records.map((record) => record.pre?.[metric]))];
    }
    const covered = records
      .map((record) => record.during?.[metric])
      .filter((entry) => entry && Number.isFinite(entry.mean));
    if (covered.length === 0) {
      return [metric, { runsWithValue: 0, observations: 0, min: null, max: null, meanOfRunMeans: null }];
    }
    let min = covered[0].min;
    let max = covered[0].max;
    let observations = 0;
    let sum = 0;
    for (const entry of covered) {
      min = Math.min(min, entry.min);
      max = Math.max(max, entry.max);
      observations += entry.count;
      sum += entry.mean;
    }
    return [metric, {
      runsWithValue: covered.length,
      observations,
      min,
      max,
      meanOfRunMeans: sum / covered.length,
    }];
  }));
}

function summarizeRecordGroup(records, identity) {
  return {
    ...identity,
    runs: records.length,
    joinedRuns: records.filter((record) => record.segment !== null).length,
    recentPreRuns: records.filter((record) => record.recentPre).length,
    duringCoveredRuns: records.filter((record) => record.duringSampleCount > 0).length,
    pre: summarizePeriod(records.filter((record) => record.recentPre), "pre"),
    during: summarizePeriod(records.filter((record) => record.duringSampleCount > 0), "during"),
  };
}

function grouped(records, keyOf, identityOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, entries]) => summarizeRecordGroup(entries, identityOf(entries[0], key)));
}

function sampleIntervals(segment) {
  const association = segment?.association;
  if (association && Array.isArray(association.samples)) {
    const intervals = [];
    for (const sample of association.samples) {
      const start = decimalBigInt(sample?.monotonicStartNs);
      const end = decimalBigInt(sample?.monotonicEndNs);
      const duration = decimalBigInt(sample?.readDurationNs);
      if (start === null || end === null || duration === null || end < start || end - start !== duration) return null;
      intervals.push({ sample, start, end });
    }
    return intervals;
  }
  const origin = decimalBigInt(segment?.metadata?.monotonic_origin_ns);
  if (origin === null || !Array.isArray(segment?.samples)) return null;
  const intervals = [];
  for (const sample of segment.samples) {
    const relative = decimalBigInt(sample?.monotonic_ns);
    const duration = decimalBigInt(sample?.read_duration_ns);
    if (relative === null || duration === null) return null;
    intervals.push({ sample, start: origin + relative, end: origin + relative + duration });
  }
  return intervals;
}

function allowedPreAgeNs(segment, fallbackIntervalMs) {
  const explicit = decimalBigInt(
    segment?.coverage?.cadence?.maximumAllowedSampleStartGapNs ??
    segment?.coverage?.maximumAllowedGapNs ?? "",
  );
  if (explicit !== null) return explicit;
  const interval = Number.isSafeInteger(segment?.association?.metadata?.intervalMs)
    ? segment.association.metadata.intervalMs
    : Number.isSafeInteger(segment?.intervalMs)
      ? segment.intervalMs
    : fallbackIntervalMs;
  return BigInt(Math.max(1, interval ?? 250) * 4) * 1_000_000n;
}

function duringMetric(samples, topology, cpu, metric) {
  const values = samples.map(({ sample }) => metricsForSample(sample, topology, cpu)[metric])
    .filter(Number.isFinite);
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return {
    count: values.length,
    min,
    max,
    mean: sum / values.length,
  };
}

function validateRun(run, index) {
  const start = decimalBigInt(run?.startMonotonicNs);
  const end = decimalBigInt(run?.endMonotonicNs);
  const startUnixMs = run?.startUnixMs;
  const endUnixMs = run?.endUnixMs;
  if (run?.ordinal !== index + 1 || !Number.isSafeInteger(run?.cpu) || run.cpu < 0 ||
      !["pass", "sigsegv", "other-workload-failure"].includes(run?.outcome) ||
      start === null || end === null || end < start ||
      !Number.isSafeInteger(startUnixMs) || !Number.isSafeInteger(endUnixMs) ||
      startUnixMs < 0 || endUnixMs < startUnixMs) return null;
  return { ...run, start, end, startUnixMs, endUnixMs };
}

/**
 * Join validated exact-CPU workload runs to validated telemetry sweeps.
 * A pre-run observation is the latest sweep fully completed before launch and
 * no older than the cadence allowance. A during-run observation is a sweep
 * wholly contained inside the child lifetime. This avoids pretending a sysfs
 * sweep is an instantaneous measurement.
 */
export function associateTelemetryRuns(options = {}) {
  const runs = options.runs;
  const telemetry = options.telemetryAssessment;
  const reasons = [];
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > MAX_RUNS) {
    return { status: "invalid", reasons: ["exact workload runs are missing or exceed association bounds"] };
  }
  if (!GENERATION_RE.test(options.workloadGeneration ?? "") ||
      !DIGEST_RE.test(options.workloadBoundariesSha256 ?? "") ||
      options.workloadBoundaryRowCount !== runs.length) {
    return { status: "invalid", reasons: ["workload generation or boundary binding does not reconcile"] };
  }
  if (telemetry?.status !== "complete") reasons.push("telemetry envelope is not complete");
  if (options.workloadBindingReconciled !== true) reasons.push("telemetry is not bound to this workload evidence generation");
  const preparedSegments = [];
  for (const segment of telemetry?.segments ?? []) {
    const start = decimalBigInt(segment?.boundary?.start?.monotonicNs);
    const end = decimalBigInt(segment?.boundary?.end?.monotonicNs);
    const startUnixMs = segment?.boundary?.start?.unixMs;
    const endUnixMs = segment?.boundary?.end?.unixMs;
    const intervals = sampleIntervals(segment);
    if (start === null || end === null || end < start ||
        !Number.isSafeInteger(startUnixMs) || !Number.isSafeInteger(endUnixMs) ||
        startUnixMs < 0 || endUnixMs < startUnixMs ||
        intervals === null || intervals.length === 0) {
      reasons.push(`telemetry segment ${segment?.segment ?? "?"} cannot support monotonic association`);
      continue;
    }
    preparedSegments.push({
      ...segment,
      start,
      end,
      startUnixMs,
      endUnixMs,
      intervals,
      preAgeLimitNs: allowedPreAgeNs(segment, Number(telemetry?.meta?.INTERVAL_MS)),
    });
  }
  const records = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = validateRun(runs[index], index);
    if (run === null) {
      return { status: "invalid", reasons: [`workload run ${index + 1} is malformed or out of order`] };
    }
    const matching = preparedSegments.filter((segment) =>
      segment.start <= run.start && run.end <= segment.end &&
      segment.startUnixMs <= run.startUnixMs && run.endUnixMs <= segment.endUnixMs);
    if (matching.length !== 1) {
      reasons.push(`workload run ${run.ordinal} is contained by ${matching.length} telemetry segments`);
      records.push({ ...run, start: undefined, end: undefined, segment: null, recentPre: false, duringSampleCount: 0, pre: null, during: null });
      continue;
    }
    const segment = matching[0];
    const topology = topologyForCpu(segment.association?.metadata ?? segment.metadata, run.cpu);
    const preCandidates = segment.intervals.filter((sample) => sample.end <= run.start);
    const preSweep = preCandidates.at(-1) ?? null;
    const recentPre = preSweep !== null && run.start - preSweep.end <= segment.preAgeLimitNs;
    const duringSweeps = segment.intervals.filter((sample) => sample.start >= run.start && sample.end <= run.end);
    const pre = recentPre ? metricsForSample(preSweep.sample, topology, run.cpu) : null;
    const during = Object.fromEntries(METRIC_NAMES.map((metric) => [
      metric,
      duringMetric(duringSweeps, topology, run.cpu, metric),
    ]));
    records.push({
      ...run,
      start: undefined,
      end: undefined,
      segment: segment.segment,
      recentPre,
      preAgeMs: recentPre ? Number(run.start - preSweep.end) / 1_000_000 : null,
      duringSampleCount: duringSweeps.length,
      topology,
      pre,
      during,
    });
  }
  const joinedRuns = records.filter((record) => record.segment !== null).length;
  const recentPreRuns = records.filter((record) => record.recentPre).length;
  const duringCoveredRuns = records.filter((record) => record.duringSampleCount > 0).length;
  if (joinedRuns !== records.length) reasons.push(`${records.length - joinedRuns} workload run(s) lack a unique telemetry segment`);
  if (recentPreRuns !== records.length) reasons.push(`${records.length - recentPreRuns} workload run(s) lack a recent fully completed pre-run sweep`);
  if (duringCoveredRuns !== records.length) reasons.push(`${records.length - duringCoveredRuns} workload run(s) lack a fully contained during-run sweep`);
  const topology = grouped(
    records.filter((record) => record.topology !== null),
    (record) => `${record.segment}\0${record.cpu}`,
    (record) => ({ segment: record.segment, ...record.topology }),
  ).map(({ runs: _runs, joinedRuns: _joined, recentPreRuns: _pre, duringCoveredRuns: _during,
    pre: _preMetrics, during: _duringMetrics, ...entry }) => entry);
  return {
    status: reasons.length === 0 ? "complete" : "degraded",
    reasons: [...new Set(reasons)],
    workloadBinding: {
      generation: options.workloadGeneration,
      boundariesSha256: options.workloadBoundariesSha256,
      boundaryRowCount: options.workloadBoundaryRowCount,
      reconciled: options.workloadBindingReconciled === true,
    },
    telemetryGeneration: telemetry?.meta?.GENERATION ?? null,
    totalRuns: records.length,
    joinedRuns,
    recentPreRuns,
    duringCoveredRuns,
    topology,
    byContextOutcome: grouped(
      records,
      (record) => `${record.context ?? "isolated"}\0${record.outcome}`,
      (record) => ({ context: record.context ?? "isolated", outcome: record.outcome }),
    ),
    byCpu: grouped(
      records,
      (record) => `${record.context ?? "isolated"}\0${record.cpu}\0${record.outcome}`,
      (record) => ({ context: record.context ?? "isolated", cpu: record.cpu, outcome: record.outcome }),
    ),
  };
}
