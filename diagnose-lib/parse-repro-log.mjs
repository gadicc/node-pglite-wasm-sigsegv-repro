// parse-repro-log.mjs - parse and structurally validate repro.mjs output.
//
// Understands both plain repro output and lines prefixed with "<epoch>\t" by
// diagnose.sh. Counts are derived only from accepted, unique wave rows; the
// completion footer is corroborating structure, never a source of trials.

import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

const UINT = "(?:0|[1-9][0-9]*)";
const POSITIVE_UINT = "(?:[1-9][0-9]*)";
const HEADER_RE = new RegExp(
  `^node=(\\S+) v8=(\\S+) platform=(\\S+) arch=(\\S+) children=(${POSITIVE_UINT}) waves=(${POSITIVE_UINT})$`,
);
const WAVE_RE = new RegExp(`^wave=(${POSITIVE_UINT}) passed=(${UINT})/(${POSITIVE_UINT})$`);
const CHILD_RE = new RegExp(
  `^child=(${UINT}) code=(null|${UINT}) signal=(null|SIG[A-Z0-9]+) elapsedMs=(${UINT})$`,
);
const FOOTER_RE = new RegExp(
  `^failedWaves=(${UINT}) completedWaves=(${UINT}) requestedWaves=(${POSITIVE_UINT})$`,
);
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));

function safeUint(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function stripTimestamp(rawLine) {
  const match = rawLine.match(/^([^\t]*)\t(.*)$/);
  if (!match) return { epoch: null, line: rawLine, timestampStyle: "plain" };
  if (/^[1-9][0-9]{8,}$/.test(match[1]) && safeUint(match[1]) !== null) {
    return { epoch: safeUint(match[1]), line: match[2], timestampStyle: "prefixed" };
  }
  if (isReserved(match[2])) {
    return { epoch: null, line: match[2], timestampStyle: "invalid" };
  }
  return { epoch: null, line: rawLine, timestampStyle: "plain" };
}

function isReserved(line) {
  return /^(?:node=|wave=|child=|failedWaves=)/.test(line);
}

function sameChildOutcome(left, right) {
  return left.code === right.code &&
    left.signal === right.signal;
}

function childDetailFingerprint(detail) {
  return `${detail.code ?? "null"}\u0000${detail.signal ?? "null"}\u0000${detail.elapsedMs}`;
}

export function parseReproLog(text, expectations = {}) {
  const out = {
    node: null,
    v8: null,
    children: null,
    requestedWaves: null,
    processedWaves: 0,
    completedWaves: 0,
    fullyPassedWaves: 0,
    failedWaves: 0,
    waves: [],
    failures: [],
    totalChildInvocations: 0,
    sigsegvCount: 0,
    otherFailureCount: 0,
    unclassifiedFailureCount: 0,
    sigsegvWaveCount: 0,
    sigsegvResolvedWaveCount: 0,
    sigsegvUnresolvedWaveCount: 0,
    otherFailureWaveCount: 0,
    unclassifiedFailureWaveCount: 0,
    firstFailureAfterSec: null,
    durationSec: null,
    finalLine: null,
    footer: null,
    completionStatus: "inconsistent",
    partial: false,
    issues: [],
    notes: [],
  };

  const headers = [];
  const footers = [];
  const occurrences = [];
  const structuralRecords = [];
  const issueKeys = new Set();
  let currentOccurrence = null;

  const issue = (code, message, lineNumber = null) => {
    const key = `${code}\u0000${message}\u0000${lineNumber ?? ""}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    out.issues.push({ code, message, ...(lineNumber === null ? {} : { line: lineNumber }) });
    out.notes.push(message);
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim()) continue;
    const lineNumber = index + 1;
    const { epoch, line, timestampStyle } = stripTimestamp(rawLine);

    let match = line.match(HEADER_RE);
    if (match) {
      const header = {
        node: match[1],
        v8: match[2],
        platform: match[3],
        arch: match[4],
        children: safeUint(match[5]),
        requestedWaves: safeUint(match[6]),
        line: lineNumber,
        _epoch: epoch,
      };
      headers.push(header);
      structuralRecords.push({ kind: "header", line: lineNumber, epoch, timestampStyle });
      if (header.children === null || header.requestedWaves === null) {
        issue("numeric-range", "header numeric fields exceed the safe integer range", lineNumber);
      }
      currentOccurrence = null;
      continue;
    }

    match = line.match(WAVE_RE);
    if (match) {
      const occurrence = {
        wave: safeUint(match[1]),
        passed: safeUint(match[2]),
        of: safeUint(match[3]),
        epoch,
        line: lineNumber,
        details: [],
        accepted: false,
        _numericValid: true,
      };
      occurrence._numericValid = occurrence.wave !== null && occurrence.passed !== null && occurrence.of !== null;
      occurrences.push(occurrence);
      structuralRecords.push({ kind: "wave", line: lineNumber, epoch, timestampStyle });
      if (!occurrence._numericValid) {
        issue("numeric-range", "wave numeric fields exceed the safe integer range", lineNumber);
      }
      currentOccurrence = occurrence;
      if (occurrence.passed > occurrence.of) {
        issue("impossible-wave", `wave=${occurrence.wave} row is impossible: passed=${occurrence.passed}/${occurrence.of}`, lineNumber);
      }
      continue;
    }

    match = line.match(CHILD_RE);
    if (match) {
      const detail = {
        child: safeUint(match[1]),
        code: match[2] === "null" ? null : safeUint(match[2]),
        signal: match[3] === "null" ? null : match[3],
        elapsedMs: safeUint(match[4]),
        _epoch: epoch,
        _line: lineNumber,
      };
      const detailIsValid = detail.child !== null && detail.elapsedMs !== null &&
        (match[2] === "null" || detail.code !== null);
      const isExitFailure = detail.code !== null && detail.code > 0 && detail.code <= 255 && detail.signal === null;
      const isSignalFailure = detail.code === null && KNOWN_SIGNALS.has(detail.signal);
      if (!detailIsValid) {
        issue("numeric-range", "child numeric fields exceed the safe integer range", lineNumber);
      } else if (!isExitFailure && !isSignalFailure) {
        issue(
          "invalid-child-outcome",
          `child=${detail.child} row does not describe exactly one nonzero exit code or known signal`,
          lineNumber,
        );
      } else if (currentOccurrence === null) {
        issue("orphan-child", "child failure detail is not attached to a preceding wave row", lineNumber);
      } else if (detail.child < 1 || detail.child > currentOccurrence.of) {
        issue(
          "child-out-of-range",
          `child=${detail.child} row ignored: outside wave=${currentOccurrence.wave} children 1..${currentOccurrence.of}`,
          lineNumber,
        );
      } else {
        currentOccurrence.details.push(detail);
      }
      structuralRecords.push({ kind: "child", line: lineNumber, epoch, timestampStyle });
      continue;
    }

    match = line.match(FOOTER_RE);
    if (match) {
      const footer = {
        failedWaves: safeUint(match[1]),
        completedWaves: safeUint(match[2]),
        requestedWaves: safeUint(match[3]),
        line: lineNumber,
        raw: line,
        _epoch: epoch,
      };
      footers.push(footer);
      structuralRecords.push({ kind: "footer", line: lineNumber, epoch, timestampStyle });
      if (footer.failedWaves === null || footer.completedWaves === null || footer.requestedWaves === null) {
        issue("numeric-range", "footer numeric fields exceed the safe integer range", lineNumber);
      }
      currentOccurrence = null;
      continue;
    }

    if (isReserved(line)) {
      issue("malformed-record", `line ${lineNumber} resembles a repro record but is not canonical`, lineNumber);
      structuralRecords.push({ kind: "malformed", line: lineNumber, epoch, timestampStyle });
      // A malformed child record cannot contribute evidence, but it also
      // cannot make a later canonical child record migrate away from the
      // otherwise unambiguous preceding wave. Other malformed structural
      // records break that attachment.
      if (!line.startsWith("child=")) currentOccurrence = null;
    }
  }

  if (headers.length !== 1) {
    issue("header-count", `expected exactly one canonical header, found ${headers.length}`);
  }
  if (footers.length > 1) {
    issue("footer-count", `expected at most one canonical footer, found ${footers.length}`);
  }

  if (structuralRecords.some((record) => record.timestampStyle === "invalid")) {
    issue("invalid-timestamp", "a repro record has a non-canonical timestamp prefix");
  }
  const timestampStyles = new Set(
    structuralRecords
      .map((record) => record.timestampStyle)
      .filter((style) => style !== "invalid"),
  );
  if (timestampStyles.size > 1) {
    issue("mixed-timestamps", "repro records mix plain and epoch-prefixed forms");
  }
  let previousEpoch = null;
  for (const record of structuralRecords) {
    if (record.epoch === null) continue;
    if (previousEpoch !== null && record.epoch < previousEpoch) {
      issue("decreasing-timestamp", "repro record timestamps decrease in file order", record.line);
    }
    previousEpoch = record.epoch;
  }

  const header = headers[0] ?? null;
  if (header) {
    out.node = header.node;
    out.v8 = header.v8;
    out.children = header.children;
    out.requestedWaves = header.requestedWaves;
  }
  if (header && structuralRecords[0]?.kind !== "header") {
    issue("header-order", "the canonical header is not the first repro record", header.line);
  }

  const seenWaves = new Set();
  let expectedSequence = 1;
  let acceptedInvocationCount = 0;
  for (const occurrence of occurrences) {
    let accepted = occurrence._numericValid;
    if (occurrence.passed > occurrence.of) accepted = false;
    if (header && occurrence.of !== header.children) {
      issue(
        "wave-children-mismatch",
        `wave=${occurrence.wave} row ignored: passed=${occurrence.passed}/${occurrence.of} disagrees with header children=${header.children}`,
        occurrence.line,
      );
      accepted = false;
    }
    if (header && occurrence.wave > header.requestedWaves) {
      issue(
        "wave-out-of-range",
        `wave=${occurrence.wave} row ignored: outside requested waves 1..${header.requestedWaves}`,
        occurrence.line,
      );
      accepted = false;
    }
    if (seenWaves.has(occurrence.wave)) {
      issue("duplicate-wave", `duplicate wave=${occurrence.wave} row ignored (first occurrence kept)`, occurrence.line);
      accepted = false;
    } else {
      seenWaves.add(occurrence.wave);
    }
    if (occurrence.wave !== expectedSequence) {
      issue(
        "wave-sequence",
        `wave row sequence is not contiguous: expected wave=${expectedSequence}, found wave=${occurrence.wave}`,
        occurrence.line,
      );
    } else {
      expectedSequence += 1;
    }
    if (accepted) {
      if (occurrence.of > Number.MAX_SAFE_INTEGER - acceptedInvocationCount) {
        issue(
          "invocation-count-overflow",
          `wave=${occurrence.wave} row ignored: cumulative accepted child invocations would exceed the safe integer range`,
          occurrence.line,
        );
        accepted = false;
      } else {
        acceptedInvocationCount += occurrence.of;
      }
    }
    occurrence.accepted = accepted;
    if (!accepted && occurrence.details.length > 0) {
      out.notes.push(`child failure detail attached to rejected wave=${occurrence.wave} row ignored`);
    }
  }

  const accepted = occurrences.filter((occurrence) => occurrence.accepted);
  const waveEvidence = new Map();
  for (const occurrence of accepted) {
    out.waves.push({ wave: occurrence.wave, passed: occurrence.passed, of: occurrence.of });
    out.processedWaves += 1;
    out.completedWaves += 1;
    out.totalChildInvocations += occurrence.of;
    if (occurrence.passed === occurrence.of) out.fullyPassedWaves += 1;
    else out.failedWaves += 1;

    const expectedFailures = occurrence.of - occurrence.passed;
    const evidence = { sigsegv: 0, other: 0, unclassified: 0 };
    waveEvidence.set(occurrence.wave, evidence);
    const detailsByChild = new Map();
    for (const detail of occurrence.details) {
      const previous = detailsByChild.get(detail.child);
      if (!previous) {
        detailsByChild.set(detail.child, {
          detail,
          fingerprints: new Set([childDetailFingerprint(detail)]),
          conflicted: false,
        });
      } else if (!previous.conflicted && sameChildOutcome(previous.detail, detail)) {
        const fingerprint = childDetailFingerprint(detail);
        const isExactDuplicate = previous.fingerprints.has(fingerprint);
        issue(
          isExactDuplicate ? "duplicate-child-detail" : "duplicate-child-metadata",
          isExactDuplicate
            ? `duplicate child=${detail.child} detail for wave=${occurrence.wave} ignored`
            : `duplicate child=${detail.child} outcome for wave=${occurrence.wave} has conflicting elapsed time; outcome retained without timing`,
          detail._line,
        );
        previous.fingerprints.add(fingerprint);
        if (!isExactDuplicate) previous.detail.elapsedMs = null;
      } else {
        if (!previous.conflicted) {
          issue(
            "conflicting-child-detail",
            `conflicting child=${detail.child} details for wave=${occurrence.wave}; that failure slot is unclassified`,
            detail._line,
          );
        }
        previous.conflicted = true;
      }
    }

    if (detailsByChild.size > expectedFailures) {
      issue(
        "overfull-child-details",
        `wave=${occurrence.wave} has ${detailsByChild.size} unique child detail id(s), exceeding ${expectedFailures} failure slot(s) in its summary`,
        occurrence.line,
      );
      out.unclassifiedFailureCount += expectedFailures;
      evidence.unclassified = expectedFailures;
      out.notes.push(
        `wave=${occurrence.wave} child details conflict with its summary; all ${expectedFailures} failure(s) remain unclassified`,
      );
      continue;
    }

    let classifiedFailures = 0;
    for (const { detail, conflicted } of detailsByChild.values()) {
      if (conflicted) continue;
      out.failures.push({ wave: occurrence.wave, ...detail });
      classifiedFailures += 1;
    }
    const unclassifiedFailures = expectedFailures - classifiedFailures;
    out.unclassifiedFailureCount += unclassifiedFailures;
    evidence.unclassified = unclassifiedFailures;
    if (unclassifiedFailures > 0) {
      out.notes.push(
        `wave=${occurrence.wave} summary reports ${expectedFailures} failure(s), but only ${classifiedFailures} child detail line(s) were usable`,
      );
    }
  }

  for (const failure of out.failures) {
    const evidence = waveEvidence.get(failure.wave);
    if (failure.signal === "SIGSEGV") {
      out.sigsegvCount += 1;
      evidence.sigsegv += 1;
    } else {
      out.otherFailureCount += 1;
      evidence.other += 1;
    }
  }
  for (const occurrence of accepted) {
    const evidence = waveEvidence.get(occurrence.wave);
    if (evidence.other > 0) out.otherFailureWaveCount += 1;
    if (evidence.unclassified > 0) out.unclassifiedFailureWaveCount += 1;
    if (evidence.sigsegv > 0) {
      // A single confirmed SIGSEGV resolves the binary endpoint for its
      // entire wave, even when other child outcomes in that wave are not
      // classifiable. Concurrent children are deliberately not independent
      // trials for the rate estimate.
      out.sigsegvWaveCount += 1;
      out.sigsegvResolvedWaveCount += 1;
    } else if (occurrence.passed === occurrence.of) {
      // Only a summary-clean wave is a resolved negative. Other failures and
      // missing child detail cannot be silently counted as non-SIGSEGV.
      out.sigsegvResolvedWaveCount += 1;
    } else {
      out.sigsegvUnresolvedWaveCount += 1;
    }
  }
  const footer = footers[0] ?? null;
  if (footer) {
    if (structuralRecords.at(-1)?.kind !== "footer") {
      issue("footer-order", "the canonical footer is not the last repro record", footer.line);
    }
    out.footer = { ...footer };
    delete out.footer.raw;
    delete out.footer._epoch;
    out.finalLine = footer.raw;
    if (header && footer.requestedWaves !== header.requestedWaves) {
      issue(
        "footer-header-mismatch",
        `footer requestedWaves=${footer.requestedWaves} disagrees with header waves=${header.requestedWaves}`,
        footer.line,
      );
    }
    if (footer.completedWaves > footer.requestedWaves || footer.failedWaves > footer.completedWaves) {
      issue("impossible-footer", "completion footer contains impossible wave counts", footer.line);
    }
    if (footer.completedWaves !== accepted.length) {
      issue(
        "footer-row-count-mismatch",
        `footer completedWaves=${footer.completedWaves} disagrees with ${accepted.length} accepted wave row(s)`,
        footer.line,
      );
    }
    if (footer.failedWaves !== out.failedWaves) {
      issue(
        "footer-failure-mismatch",
        `footer failedWaves=${footer.failedWaves} disagrees with ${out.failedWaves} failed accepted wave row(s)`,
        footer.line,
      );
    }
    if (accepted.length !== footer.completedWaves ||
        accepted.some(({ wave }, index) => wave !== index + 1)) {
      issue("footer-wave-sequence", "accepted wave rows are not exactly 1..footer.completedWaves", footer.line);
    }
  }

  const reconcilePositiveExpectation = (key, label) => {
    if (!Object.hasOwn(expectations, key)) return null;
    const value = expectations[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      issue("invalid-expectation", `${label} expectation is missing or invalid`);
      return null;
    }
    return value;
  };
  const expectedChildren = reconcilePositiveExpectation("expectedChildren", "children");
  const expectedWaves = reconcilePositiveExpectation("expectedWaves", "waves");
  if (expectedChildren !== null && header && header.children !== expectedChildren) {
    issue("expected-children-mismatch", `header children=${header.children} disagrees with expected children=${expectedChildren}`, header.line);
  }
  if (expectedWaves !== null && header && header.requestedWaves !== expectedWaves) {
    issue("expected-waves-mismatch", `header waves=${header.requestedWaves} disagrees with expected waves=${expectedWaves}`, header.line);
  }
  if (expectedWaves !== null && footer) {
    if (footer.requestedWaves !== expectedWaves) {
      issue("expected-footer-waves-mismatch", `footer requestedWaves=${footer.requestedWaves} disagrees with expected waves=${expectedWaves}`, footer.line);
    }
    if (footer.completedWaves !== expectedWaves) {
      issue("incomplete-footer", `footer completedWaves=${footer.completedWaves} does not complete expected waves=${expectedWaves}`, footer.line);
    }
  }
  if (footer && Object.hasOwn(expectations, "exitCode")) {
    const exitCode = expectations.exitCode;
    if (exitCode !== 0 && exitCode !== 1) {
      issue("invalid-exit-code", `repro exit code ${String(exitCode)} is not 0 or 1`);
    } else {
      const expectedExit = footer.failedWaves === 0 ? 0 : 1;
      if (exitCode !== expectedExit) {
        issue(
          "exit-code-mismatch",
          `repro exit code ${exitCode} disagrees with footer failedWaves=${footer.failedWaves}`,
          footer.line,
        );
      }
    }
  }

  if (out.issues.length === 0) {
    out.completionStatus = footer ? "complete" : "partial";
  }
  out.partial = out.completionStatus === "partial";

  const acceptedFailureEpochs = accepted
    .filter((wave) => wave.passed < wave.of)
    .flatMap((wave) => [wave.epoch, ...wave.details.map((detail) => detail._epoch)])
    .filter((epoch) => epoch !== null);
  const timingEpochs = [
    header?._epoch,
    ...accepted.flatMap((wave) => [wave.epoch, ...wave.details.map((detail) => detail._epoch)]),
    footer?._epoch,
  ].filter((epoch) => epoch !== null && epoch !== undefined);
  const timingIsUsable = timestampStyles.size === 1 && timestampStyles.has("prefixed") &&
    !out.issues.some((entry) => entry.code === "invalid-timestamp" || entry.code === "decreasing-timestamp");
  const startEpoch = timingIsUsable ? header?._epoch : null;
  if (startEpoch !== null && startEpoch !== undefined && acceptedFailureEpochs.length > 0) {
    out.firstFailureAfterSec = Math.min(...acceptedFailureEpochs) - startEpoch;
  }
  if (startEpoch !== null && startEpoch !== undefined && timingEpochs.length > 0) {
    out.durationSec = Math.max(...timingEpochs) - startEpoch;
  }
  for (const failure of out.failures) {
    delete failure._epoch;
    delete failure._line;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--validate-complete") {
    const [file, childrenS, wavesS, exitCodeS] = args.slice(1);
    if (!file || childrenS === undefined || wavesS === undefined || exitCodeS === undefined) {
      console.error("usage: node parse-repro-log.mjs --validate-complete <log> <children> <waves> <exit-code>");
      process.exit(2);
    }
    const result = parseReproLog(readFileSync(file, "utf8"), {
      expectedChildren: Number(childrenS),
      expectedWaves: Number(wavesS),
      exitCode: Number(exitCodeS),
    });
    if (result.completionStatus !== "complete") {
      for (const entry of result.issues) console.error(`${entry.code}: ${entry.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const file = args[0];
  if (!file) {
    console.error("usage: node parse-repro-log.mjs <log-file>");
    process.exit(2);
  }
  console.log(JSON.stringify(parseReproLog(readFileSync(file, "utf8")), null, 2));
}
