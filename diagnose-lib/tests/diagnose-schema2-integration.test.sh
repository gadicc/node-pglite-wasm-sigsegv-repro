#!/usr/bin/env bash
# Focused, offline integration tests for the schema-2 diagnose.sh orchestration.
#
# The real crash workload, telemetry/frequency writers, GDB runner, and sysfs
# boundaries are all replaced with shell mocks. Only synthetic files below a
# temporary directory are created.
set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

DIAG_SOURCE_ONLY=1
# shellcheck source=../../diagnose.sh
source "$REPO_ROOT/diagnose.sh"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  printf 'ok   %s\n' "$1"
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL %s\n' "$1" >&2
}

check_true() {
  local label="$1"
  shift
  if "$@"; then
    ok "$label"
  else
    bad "$label"
  fi
}

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label"
  else
    bad "$label (expected [$expected], got [$actual])"
  fi
}

phase_events() {
  local phase="$1" schema="$2" bundle="$3" events="$4"
  mkdir -p -- "$bundle/results"
  : > "$events"

  (
    OUT_DIR="$bundle"
    STATE_DIR="$bundle/state"
    META_FILE="$bundle/results/meta.env"
    RUN_SCHEMA_VERSION="$schema"
    BASELINE_CHILDREN=2
    BASELINE_WAVES=1
    GROUP_WAVES=1
    DIAG_WORKLOAD_PID=""
    DIAG_TELEMETRY_PID=""
    GROUP_NAME=(group-a group-b)
    GROUP_KIND=(uniform uniform)
    GROUP_CPUS=(0 1)
    GROUP_CLUSTER=(- -)

    record() { printf '%s\n' "$1" >> "$events"; }
    forbidden_boundary() {
      record "forbidden:$1"
      return 97
    }

    # Hard guards: an orchestration regression must not silently reach a real
    # process boundary from this offline test.
    node() { forbidden_boundary node; }
    taskset() { forbidden_boundary taskset; }
    diag_process_group_start() { forbidden_boundary process-group-start; }
    diag_supervised_group_start() { forbidden_boundary supervised-group-start; }

    diag_log() { :; }
    baseline_prepare_fresh_targets() { record baseline-prepare; }
    groups_prepare_fresh_targets() { record groups-prepare; }
    groups_meta_publish() { record "groups-meta-$1"; }
    groups_require_fresh_row_targets() { record "group-target-$1"; }
    group_children() { printf '1'; }
    diag_freq_sampler_start() { record "freq-start:$1"; }
    diag_freq_sampler_stop() { record freq-stop; }
    telemetry_sampler_start() { record "telemetry-start:$1:$2:$3"; }
    telemetry_boundary_start() { record telemetry-boundary; }
    telemetry_segment_stop() {
      record telemetry-stop
      DIAG_TELEMETRY_PID=""
    }
    telemetry_phase_publish() { record "telemetry-publish:$1:$2"; }
    run_repro_logged() {
      record "workload-mock:$2:$3:$4"
      REPRO_RC=0
      DIAG_WORKLOAD_PID=""
    }
    repro_result_is_complete() { return 0; }
    baseline_evidence_is_complete() { return 0; }
    groups_evidence_is_complete() { return 0; }
    mark_done() { record "mark:$1"; }

    case "$phase" in
      baseline) phase_baseline ;;
      groups) phase_groups ;;
      *) return 98 ;;
    esac
  )
}

echo '== schema-aware phase telemetry =='
for phase in baseline groups; do
  for schema in 1 2; do
    case_root="$TMP_ROOT/$phase-schema-$schema"
    phase_events "$phase" "$schema" "$case_root/bundle" "$case_root.events"
    phase_rc=$?
    check_eq "$phase schema $schema completes through mocks" 0 "$phase_rc"
    check_true "$phase schema $schema reaches only the mocked workload" \
      grep -q '^workload-mock:' "$case_root.events"
    if grep -q '^forbidden:' "$case_root.events"; then
      bad "$phase schema $schema crossed a real process boundary"
    else
      ok "$phase schema $schema crosses no real process boundary"
    fi
    if [[ "$schema" == 1 ]]; then
      if grep -q '^telemetry-' "$case_root.events"; then
        bad "$phase schema 1 does not invoke telemetry"
      else
        ok "$phase schema 1 does not invoke telemetry"
      fi
    else
      telemetry_starts="$(grep -c '^telemetry-start:' "$case_root.events" || true)"
      telemetry_boundaries="$(grep -c '^telemetry-boundary$' "$case_root.events" || true)"
      telemetry_stops="$(grep -c '^telemetry-stop$' "$case_root.events" || true)"
      telemetry_publishes="$(grep -c '^telemetry-publish:' "$case_root.events" || true)"
      expected_segments=1
      [[ "$phase" == groups ]] && expected_segments=2
      check_eq "$phase schema 2 starts telemetry for every workload segment" \
        "$expected_segments" "$telemetry_starts"
      check_eq "$phase schema 2 records every workload boundary" \
        "$expected_segments" "$telemetry_boundaries"
      check_eq "$phase schema 2 stops every telemetry writer" \
        "$expected_segments" "$telemetry_stops"
      check_eq "$phase schema 2 publishes one descriptive envelope" \
        1 "$telemetry_publishes"
    fi
  done
done

echo '== fixed protocol finalization stages =='
FINAL_ROOT="$TMP_ROOT/finalization"
mkdir -p -- "$FINAL_ROOT/state/individual-finalize"
printf 'stranded result\n' > "$FINAL_ROOT/state/individual-finalize/individual.tsv"
printf 'stranded metadata\n' > "$FINAL_ROOT/state/individual-finalize/individual.meta"
(
  OUT_DIR="$FINAL_ROOT"
  STATE_DIR="$FINAL_ROOT/state"
  sync() { :; }
  protocol_finalize_stage_prepare "$STATE_DIR/individual-finalize" \
    individual.tsv individual.meta &&
    [[ -d "$STATE_DIR/individual-finalize" ]] &&
    [[ -z "$(find "$STATE_DIR/individual-finalize" -mindepth 1 -print -quit)" ]] &&
    protocol_finalize_stage_close "$STATE_DIR/individual-finalize"
)
known_stage_rc=$?
check_eq 'fixed finalization stage removes only known stranded candidates' 0 "$known_stage_rc"
check_true 'known finalization stage closes cleanly after regeneration setup' \
  test ! -e "$FINAL_ROOT/state/individual-finalize"

mkdir -p -- "$FINAL_ROOT/state/pinned-concurrent-finalize"
printf 'unrecognized evidence\n' \
  > "$FINAL_ROOT/state/pinned-concurrent-finalize/not-owned-by-finalizer"
if (
  OUT_DIR="$FINAL_ROOT"
  STATE_DIR="$FINAL_ROOT/state"
  sync() { :; }
  protocol_finalize_stage_prepare "$STATE_DIR/pinned-concurrent-finalize" \
    pinned-concurrent.tsv pinned-concurrent.meta
); then
  unknown_stage_rc=0
else
  unknown_stage_rc=$?
fi
check_true 'fixed finalization stage rejects unknown stranded entries' \
  test "$unknown_stage_rc" -ne 0
check_true 'unknown finalization entry is preserved on rejection' \
  test -f "$FINAL_ROOT/state/pinned-concurrent-finalize/not-owned-by-finalizer"

echo '== descriptive telemetry resume =='
TELEMETRY_ROOT="$TMP_ROOT/telemetry-resume"
TELEMETRY_GENERATION=0123456789abcdef0123456789abcdef
mkdir -p -- "$TELEMETRY_ROOT/telemetry/individual" \
  "$TELEMETRY_ROOT/state/telemetry-individual"
printf '%s\n' "$TELEMETRY_GENERATION" \
  > "$TELEMETRY_ROOT/state/telemetry-individual/generation"
printf '{"orphan":true}\n' \
  > "$TELEMETRY_ROOT/state/telemetry-individual/$TELEMETRY_GENERATION-1.start.json"
(
  OUT_DIR="$TELEMETRY_ROOT"
  STATE_DIR="$TELEMETRY_ROOT/state"
  telemetry_phase_generation_read() { printf '%s\n' "$TELEMETRY_GENERATION"; }
  ! telemetry_resumable_prepare individual individual-session-
)
orphan_reject_rc=$?
check_eq 'telemetry resume rejects an orphan start-state file' 0 "$orphan_reject_rc"

descriptive_result="$(
  OUT_DIR="$TELEMETRY_ROOT"
  STATE_DIR="$TELEMETRY_ROOT/state"
  TELEMETRY_DEGRADED=0
  TELEMETRY_RESUME_AVAILABLE=9
  telemetry_phase_generation_read() { printf '%s\n' "$TELEMETRY_GENERATION"; }
  diag_warn() { :; }
  telemetry_resumable_prepare_descriptive individual individual-session-
  printf '%s|%s|%s|%s\n' "$?" "$TELEMETRY_DEGRADED" \
    "$TELEMETRY_RESUME_AVAILABLE" "$TELEMETRY_RESUME_SEGMENTS_JSON"
)"
check_eq 'descriptive telemetry wrapper degrades without failing workload resume' \
  '0|1|0|[]' "$descriptive_result"

echo '== telemetry workload parent binding =='
BINDING_ROOT="$TMP_ROOT/telemetry-binding"
BINDING_EVENTS="$BINDING_ROOT/events"
mkdir -p -- "$BINDING_ROOT/results" "$BINDING_ROOT/state/telemetry-individual"
printf '%s\n' "$TELEMETRY_GENERATION" \
  > "$BINDING_ROOT/state/telemetry-individual/generation"
: > "$BINDING_EVENTS"
binding_result="$(
  OUT_DIR="$BINDING_ROOT"
  STATE_DIR="$BINDING_ROOT/state"
  LIB="$REPO_ROOT/diagnose-lib"
  TELEMETRY_INTERVAL_MS=250
  TELEMETRY_DEGRADED=0
  telemetry_phase_generation_read() { printf '%s\n' "$TELEMETRY_GENERATION"; }
  diag_warn() { printf 'warn:%s\n' "$*" >> "$BINDING_EVENTS"; }
  node() {
    case "$1" in
      */telemetry-workload-binding.mjs)
        printf '%s\n' \
          'VERSION=1' \
          'FORMAT=node-pglite-diagnostics/telemetry-workload-binding/v1' \
          'PHASE=individual' \
          'WORKLOAD_GENERATION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
          "WORKLOAD_BINDING_SHA256=$(printf 'b%.0s' {1..64})" \
          "WORKLOAD_BOUNDARIES_SHA256=$(printf 'c%.0s' {1..64})" \
          'WORKLOAD_BOUNDARY_ROW_COUNT=400'
        ;;
      */telemetry-session.mjs)
        printf '%s\n' "$*" >> "$BINDING_EVENTS"
        printf '{"status":"complete","rows":1}\n'
        ;;
      *) return 97 ;;
    esac
  }
  telemetry_phase_publish individual '[{"segment":1,"tag":"individual-session-1"}]'
  printf '%s|%s\n' "$?" "$TELEMETRY_DEGRADED"
)"
check_eq 'telemetry publication keeps valid bound evidence available' '0|0' "$binding_result"
check_true 'telemetry envelope receives the workload generation binding' \
  grep -Fq -- '--workload-generation aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$BINDING_EVENTS"
check_true 'telemetry envelope receives the composite workload digest' \
  grep -Fq -- "--workload-binding-sha256 $(printf 'b%.0s' {1..64})" "$BINDING_EVENTS"
check_true 'telemetry envelope receives the exact boundary digest and row count' \
  grep -Fq -- "--workload-boundaries-sha256 $(printf 'c%.0s' {1..64}) --workload-boundary-row-count 400" "$BINDING_EVENTS"

: > "$BINDING_EVENTS"
malformed_binding_result="$(
  OUT_DIR="$BINDING_ROOT"
  STATE_DIR="$BINDING_ROOT/state"
  LIB="$REPO_ROOT/diagnose-lib"
  TELEMETRY_INTERVAL_MS=250
  TELEMETRY_DEGRADED=0
  telemetry_phase_generation_read() { printf '%s\n' "$TELEMETRY_GENERATION"; }
  diag_warn() { printf 'warn:%s\n' "$*" >> "$BINDING_EVENTS"; }
  node() {
    case "$1" in
      */telemetry-workload-binding.mjs)
        printf '%s\n' 'VERSION=1' 'VERSION=1'
        ;;
      */telemetry-session.mjs)
        printf 'unexpected-session\n' >> "$BINDING_EVENTS"
        return 97
        ;;
      *) return 97 ;;
    esac
  }
  telemetry_phase_publish individual '[{"segment":1,"tag":"individual-session-1"}]'
  printf '%s|%s\n' "$?" "$TELEMETRY_DEGRADED"
)"
check_eq 'malformed workload binding degrades telemetry without failing workload evidence' \
  '0|1' "$malformed_binding_result"
if grep -Fq 'unexpected-session' "$BINDING_EVENTS"; then
  bad 'malformed workload binding cannot reach envelope publication'
else
  ok 'malformed workload binding cannot reach envelope publication'
fi
check_true 'malformed workload binding emits an explicit descriptive warning' \
  grep -Fq 'could not bind the exact owning workload evidence' "$BINDING_EVENTS"

echo '== atomic concurrent-context discovery =='
context_result="$(
  ONLINE_CPUS=0-2
  GROUP_NAME=(first second)
  GROUP_KIND=(uniform uniform)
  GROUP_CPUS=(0 0-2)
  GROUP_CLUSTER=(- -)
  cpulist_first_outside() {
    [[ "$1" == 0 ]] || return 1
    printf '2\n'
  }
  add_partitioned_concurrent_contexts() { return 1; }
  build_concurrent_contexts
  printf '%s|%s|%s|%s|%s|%s\n' \
    "${#CONCURRENT_NAME[@]}" "${#CONCURRENT_KIND[@]}" \
    "${#CONCURRENT_CPUS[@]}" "${#CONCURRENT_CLUSTER[@]}" \
    "${#CONCURRENT_CONTROLLER[@]}" "$PINNED_CONCURRENT_UNAVAILABLE_REASON"
)"
check_eq 'one undiscoverable context clears every partially accumulated context' \
  '0|0|0|0|0|no topology partition leaves a controller CPU outside the active set' \
  "$context_result"

echo '== telemetry-only GDB attempt ownership =='
GDB_ROOT="$TMP_ROOT/gdb-attempt"
mkdir -p -- "$GDB_ROOT"/{results,state/telemetry-gdb,gdb,logs/gdb,telemetry/gdb}
(
  OUT_DIR="$GDB_ROOT"
  STATE_DIR="$GDB_ROOT/state"
  ! gdb_incomplete_attempt_is_meaningful
)
empty_gdb_rc=$?
check_eq 'empty prepared GDB directories are not an attempt' 0 "$empty_gdb_rc"
printf '%s\n' 0123456789abcdef0123456789abcdef \
  > "$GDB_ROOT/state/telemetry-gdb/generation"
(
  OUT_DIR="$GDB_ROOT"
  STATE_DIR="$GDB_ROOT/state"
  gdb_incomplete_attempt_is_meaningful
)
telemetry_gdb_rc=$?
check_eq 'telemetry state alone makes an incomplete GDB attempt meaningful' 0 "$telemetry_gdb_rc"

echo '== schema-aware completion state =='
schema1_completed="$({
  RUN_SCHEMA_VERSION=1
  phase_is_done() { return 0; }
  completed_phases_value
})"
check_eq 'schema 1 completion enumeration omits pinned-concurrent' \
  'preflight,baseline,groups,individual,frequency,gdb' "$schema1_completed"
schema2_completed="$({
  RUN_SCHEMA_VERSION=2
  phase_is_done() { return 0; }
  completed_phases_value
})"
check_eq 'schema 2 completion enumeration includes pinned-concurrent in order' \
  'preflight,baseline,groups,individual,pinned-concurrent,frequency,gdb' \
  "$schema2_completed"
schema1_synced="$({
  RUN_SCHEMA_VERSION=1
  phase_is_done() { return 0; }
  meta_set() { printf '%s=%s\n' "$1" "$2"; }
  sync_meta_completed
})"
check_eq 'schema 1 metadata synchronization cannot relabel a pinned phase' \
  'COMPLETED_PHASES=preflight,baseline,groups,individual,frequency,gdb' \
  "$schema1_synced"
schema2_synced="$({
  RUN_SCHEMA_VERSION=2
  phase_is_done() { return 0; }
  meta_set() { printf '%s=%s\n' "$1" "$2"; }
  sync_meta_completed
})"
check_eq 'schema 2 metadata synchronization records pinned-concurrent' \
  'COMPLETED_PHASES=preflight,baseline,groups,individual,pinned-concurrent,frequency,gdb' \
  "$schema2_synced"

LEGACY_ROOT="$TMP_ROOT/legacy-schema-artifacts"
mkdir -p -- "$LEGACY_ROOT/results" "$LEGACY_ROOT/state"
: > "$LEGACY_ROOT/state/phase-pinned-concurrent.done"
if (
  OUT_DIR="$LEGACY_ROOT"
  STATE_DIR="$LEGACY_ROOT/state"
  RUN_SCHEMA_VERSION=1
  validate_loaded_schema_artifacts
) > "$LEGACY_ROOT/marker.output" 2>&1; then
  legacy_marker_rc=0
else
  legacy_marker_rc=$?
fi
check_true 'schema 1 rejects a pinned-concurrent completion marker' \
  test "$legacy_marker_rc" -ne 0
check_true 'schema 1 marker rejection identifies schema-2 contamination' \
  grep -Fq 'legacy bundle contains a schema-2 pinned-concurrent completion marker' \
    "$LEGACY_ROOT/marker.output"
rm -f -- "$LEGACY_ROOT/state/phase-pinned-concurrent.done"
: > "$LEGACY_ROOT/state/phase-pinned-concurrent-unavailable.done"
if (
  OUT_DIR="$LEGACY_ROOT"
  STATE_DIR="$LEGACY_ROOT/state"
  RUN_SCHEMA_VERSION=1
  validate_loaded_schema_artifacts
) > "$LEGACY_ROOT/unavailable-marker.output" 2>&1; then
  legacy_unavailable_marker_rc=0
else
  legacy_unavailable_marker_rc=$?
fi
check_true 'schema 1 rejects a pinned-concurrent unavailable-decision marker' \
  test "$legacy_unavailable_marker_rc" -ne 0
check_true 'schema 1 unavailable-marker rejection identifies schema-2 contamination' \
  grep -Fq 'legacy bundle contains schema-2 pinned-concurrent artifacts' \
    "$LEGACY_ROOT/unavailable-marker.output"
rm -f -- "$LEGACY_ROOT/state/phase-pinned-concurrent-unavailable.done"
printf 'partial pinned row\n' > "$LEGACY_ROOT/results/pinned-concurrent.tsv"
if (
  OUT_DIR="$LEGACY_ROOT"
  STATE_DIR="$LEGACY_ROOT/state"
  RUN_SCHEMA_VERSION=1
  validate_loaded_schema_artifacts
) > "$LEGACY_ROOT/artifact.output" 2>&1; then
  legacy_artifact_rc=0
else
  legacy_artifact_rc=$?
fi
check_true 'schema 1 rejects marker-free pinned-concurrent artifacts' \
  test "$legacy_artifact_rc" -ne 0
check_true 'schema 1 artifact rejection identifies schema-2 contamination' \
  grep -Fq 'legacy bundle contains schema-2 pinned-concurrent artifacts' \
    "$LEGACY_ROOT/artifact.output"
(
  OUT_DIR="$LEGACY_ROOT"
  STATE_DIR="$LEGACY_ROOT/state"
  RUN_SCHEMA_VERSION=2
  validate_loaded_schema_artifacts
)
schema2_artifact_rc=$?
check_eq 'schema 2 permits pinned-concurrent artifacts for ordinary validation' \
  0 "$schema2_artifact_rc"

echo '== pinned-concurrent inverse and finalized gate =='
run_pinned_parse="$({
  SKIP_PINNED_CONCURRENT=1
  SKIP_PINNED_CONCURRENT_EXPLICIT=0
  SKIP_PINNED_CONCURRENT_FLAG_SEEN=0
  RUN_PINNED_CONCURRENT_FLAG_SEEN=0
  parse_args --run-pinned-concurrent
  printf '%s|%s|%s|%s\n' "$SKIP_PINNED_CONCURRENT" \
    "$SKIP_PINNED_CONCURRENT_EXPLICIT" \
    "$SKIP_PINNED_CONCURRENT_FLAG_SEEN" \
    "$RUN_PINNED_CONCURRENT_FLAG_SEEN"
})"
check_eq '--run-pinned-concurrent is the explicit inverse of stored skip' \
  '0|1|0|1' "$run_pinned_parse"

for conflict_order in skip-first run-first; do
  conflict_output="$TMP_ROOT/pinned-conflict-$conflict_order.output"
  if (
    SKIP_PINNED_CONCURRENT_FLAG_SEEN=0
    RUN_PINNED_CONCURRENT_FLAG_SEEN=0
    if [[ "$conflict_order" == skip-first ]]; then
      parse_args --skip-pinned-concurrent --run-pinned-concurrent
    else
      parse_args --run-pinned-concurrent --skip-pinned-concurrent
    fi
  ) > "$conflict_output" 2>&1; then
    conflict_rc=0
  else
    conflict_rc=$?
  fi
  check_true "pinned skip/run conflict is rejected ($conflict_order)" \
    test "$conflict_rc" -ne 0
  check_true "pinned skip/run conflict explains the conflict ($conflict_order)" \
    grep -Fq -- '--skip-pinned-concurrent and --run-pinned-concurrent conflict' \
      "$conflict_output"
done

FINALIZED_GATE_ROOT="$TMP_ROOT/finalized-pinned-gate"
mkdir -p -- "$FINALIZED_GATE_ROOT/results" "$FINALIZED_GATE_ROOT/state"
cat > "$FINALIZED_GATE_ROOT/results/meta.env" <<'EOF'
SKIP_PINNED_CONCURRENT=1
CPU_TARGET=auto
EOF
finalized_gate_output="$FINALIZED_GATE_ROOT/rejected.output"
if (
  OUT_DIR="$FINALIZED_GATE_ROOT"
  STATE_DIR="$FINALIZED_GATE_ROOT/state"
  RESUME_DIR="$FINALIZED_GATE_ROOT"
  RUN_SCHEMA_VERSION=2
  SKIP_PINNED_CONCURRENT=0
  SKIP_PINNED_CONCURRENT_EXPLICIT=1
  REDO_PLAN=()
  REDO_TXN_ID=""
  CONCURRENT_NAME=(newly-available-context)
  validate_completed_phase_overrides
) > "$finalized_gate_output" 2>&1; then
  finalized_gate_rc=0
else
  finalized_gate_rc=$?
fi
check_true 'resume rejects newly enabled pinned workload without redo' \
  test "$finalized_gate_rc" -ne 0
check_true 'resumed skip-choice rejection requires explicit pinned redo' \
  grep -Fq 'on resume requires --redo pinned-concurrent' \
    "$finalized_gate_output"
(
  OUT_DIR="$FINALIZED_GATE_ROOT"
  STATE_DIR="$FINALIZED_GATE_ROOT/state"
  RESUME_DIR="$FINALIZED_GATE_ROOT"
  RUN_SCHEMA_VERSION=2
  SKIP_PINNED_CONCURRENT=0
  SKIP_PINNED_CONCURRENT_EXPLICIT=1
  REDO_PLAN=(pinned-concurrent)
  REDO_TXN_ID=""
  CONCURRENT_NAME=(newly-available-context)
  validate_completed_phase_overrides
)
finalized_gate_redo_rc=$?
check_eq 'explicit pinned redo authorizes the resumed skip-choice transition' \
  0 "$finalized_gate_redo_rc"

echo '== durable topology-unavailable decision =='
UNAVAILABLE_ROOT="$TMP_ROOT/pinned-unavailable-decision"
UNAVAILABLE_GENERATION=22222222222222222222222222222222
UNAVAILABLE_DIGEST=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
mkdir -p -- "$UNAVAILABLE_ROOT/results" "$UNAVAILABLE_ROOT/state"
(
  INDIVIDUAL_GROUP_GENERATION="$UNAVAILABLE_GENERATION"
  INDIVIDUAL_GROUP_PLAN_DIGEST="$UNAVAILABLE_DIGEST"
  pinned_concurrent_unavailable_meta_render
) > "$UNAVAILABLE_ROOT/results/pinned-concurrent.unavailable.meta"

unavailable_prefix_state="$({
  OUT_DIR="$UNAVAILABLE_ROOT"
  STATE_DIR="$UNAVAILABLE_ROOT/state"
  INDIVIDUAL_GROUP_GENERATION="$UNAVAILABLE_GENERATION"
  INDIVIDUAL_GROUP_PLAN_DIGEST="$UNAVAILABLE_DIGEST"
  pinned_concurrent_unavailable_state_read
  printf '%s\n' "$PINNED_CONCURRENT_UNAVAILABLE_STATE"
})"
check_eq 'unavailable metadata without its marker is a recoverable publication prefix' \
  recoverable "$unavailable_prefix_state"
(
  OUT_DIR="$UNAVAILABLE_ROOT"
  STATE_DIR="$UNAVAILABLE_ROOT/state"
  INDIVIDUAL_GROUP_GENERATION="$UNAVAILABLE_GENERATION"
  INDIVIDUAL_GROUP_PLAN_DIGEST="$UNAVAILABLE_DIGEST"
  mark_done() {
    [[ "$1" == pinned-concurrent-unavailable ]] || return 97
    : > "$STATE_DIR/phase-pinned-concurrent-unavailable.done"
  }
  pinned_concurrent_unavailable_publish
)
unavailable_recovery_rc=$?
check_eq 'resume completes a meta-before-marker unavailable publication' \
  0 "$unavailable_recovery_rc"
check_true 'recovered unavailable publication owns its terminal marker' \
  test -f "$UNAVAILABLE_ROOT/state/phase-pinned-concurrent-unavailable.done"

unavailable_mismatch="$({
  OUT_DIR="$UNAVAILABLE_ROOT"
  STATE_DIR="$UNAVAILABLE_ROOT/state"
  INDIVIDUAL_GROUP_GENERATION="$UNAVAILABLE_GENERATION"
  INDIVIDUAL_GROUP_PLAN_DIGEST=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
  if pinned_concurrent_unavailable_state_read; then
    mismatch_rc=0
  else
    mismatch_rc=$?
  fi
  printf '%s|%s\n' "$mismatch_rc" "$PINNED_CONCURRENT_UNAVAILABLE_STATE"
})"
check_eq 'unavailable decision rejects a changed source-group binding' \
  '1|invalid' "$unavailable_mismatch"

printf 'synthetic readiness token\n' > "$UNAVAILABLE_ROOT/manifest.txt"
for manifest_state in present revoked; do
  if [[ "$manifest_state" == revoked ]]; then
    rm -f -- "$UNAVAILABLE_ROOT/manifest.txt"
  fi
  unavailable_gate="$({
    OUT_DIR="$UNAVAILABLE_ROOT"
    STATE_DIR="$UNAVAILABLE_ROOT/state"
    RUN_SCHEMA_VERSION=2
    SKIP_PINNED_CONCURRENT=0
    INDIVIDUAL_GROUP_GENERATION="$UNAVAILABLE_GENERATION"
    INDIVIDUAL_GROUP_PLAN_DIGEST="$UNAVAILABLE_DIGEST"
    CONCURRENT_NAME=(newly-available-context)
    REDO_PLAN=()
    REDO_TXN_ID=""
    pinned_concurrent_unavailable_state_read
    if pinned_concurrent_should_run; then decision=run; else decision=blocked; fi
    printf '%s|%s\n' "$PINNED_CONCURRENT_UNAVAILABLE_STATE" "$decision"
  })"
  check_eq "durable unavailable decision blocks later topology after manifest $manifest_state" \
    'complete|blocked' "$unavailable_gate"
done

unavailable_redo_gate="$({
  OUT_DIR="$UNAVAILABLE_ROOT"
  STATE_DIR="$UNAVAILABLE_ROOT/state"
  RUN_SCHEMA_VERSION=2
  SKIP_PINNED_CONCURRENT=0
  CONCURRENT_NAME=(newly-available-context)
  REDO_PLAN=(pinned-concurrent)
  REDO_TXN_ID=""
  if pinned_concurrent_should_run; then printf 'run\n'; else printf 'blocked\n'; fi
})"
check_eq 'explicit pinned redo authorizes topology reassessment' \
  run "$unavailable_redo_gate"
check_true 'pinned redo owns the unavailable decision metadata path' \
  redo_path_is_allowed pinned-concurrent results/pinned-concurrent.unavailable.meta
check_true 'pinned redo owns the unavailable decision marker path' \
  redo_path_is_allowed pinned-concurrent state/phase-pinned-concurrent-unavailable.done

unavailable_plan="$({
  OUT_DIR="$UNAVAILABLE_ROOT"
  STATE_DIR="$UNAVAILABLE_ROOT/state"
  RESUME_DIR="$UNAVAILABLE_ROOT"
  RUN_SCHEMA_VERSION=2
  MODE=default
  BASELINE_CHILDREN=1
  BASELINE_WAVES=1
  GROUP_WAVES=1
  INDIVIDUAL_RUNS=1
  PINNED_CONCURRENT_ROUNDS=1
  PROTOCOL_SEED=7
  TELEMETRY_INTERVAL_MS=250
  SKIP_PINNED_CONCURRENT=0
  GDB_MAX_RUNS=1
  SKIP_GDB=1
  CPU_TARGET=auto
  ONLINE_CPUS=0-1
  P_CORES=""
  E_CORES=""
  GROUP_NAME=()
  GROUP_KIND=()
  GROUP_CPUS=()
  GROUP_CLUSTER=()
  CONCURRENT_NAME=(newly-available-context)
  CONCURRENT_KIND=(uniform)
  CONCURRENT_CPUS=(0)
  CONCURRENT_CLUSTER=(-)
  CONCURRENT_CONTROLLER=(1)
  REDO_PLAN=()
  REDO_TXN_ID=""
  print_plan
})"
check_true 'plan reports the durable terminal-unavailable decision' \
  grep -Fq 'terminally unavailable in this bundle (--redo pinned-concurrent required to reassess)' \
    <<< "$unavailable_plan"
if grep -q '^  context ' <<< "$unavailable_plan" ||
  grep -q '^  pinned-concurrent  ~' <<< "$unavailable_plan"; then
  bad 'terminal-unavailable plan suppresses context and workload-duration claims'
else
  ok 'terminal-unavailable plan suppresses context and workload-duration claims'
fi

EMPTY_PREP_ROOT="$TMP_ROOT/pinned-empty-prep"
mkdir -p -- "$EMPTY_PREP_ROOT"/{results,logs/pinned-concurrent,state/pinned-concurrent-waves,state/pinned-concurrent-finalize,telemetry/pinned-concurrent,state/telemetry-pinned-concurrent}
(
  OUT_DIR="$EMPTY_PREP_ROOT"
  ! pinned_concurrent_workload_attempt_is_meaningful
)
empty_pinned_prep_rc=$?
check_eq 'owned real empty pinned preparation directories are not a workload attempt' \
  0 "$empty_pinned_prep_rc"
printf 'protocol activity\n' > "$EMPTY_PREP_ROOT/logs/pinned-concurrent/protocol.log"
(
  OUT_DIR="$EMPTY_PREP_ROOT"
  pinned_concurrent_workload_attempt_is_meaningful
)
nonempty_pinned_prep_rc=$?
check_eq 'a nonempty pinned preparation directory is a workload attempt' \
  0 "$nonempty_pinned_prep_rc"

echo '== pinned protocol log destination binding =='
PINNED_LOG_ROOT="$TMP_ROOT/pinned-log"
mkdir -p -- "$PINNED_LOG_ROOT"
for unsafe_kind in symlink hardlink fifo; do
  unsafe_root="$PINNED_LOG_ROOT/$unsafe_kind"
  mkdir -p -- "$unsafe_root"
  launcher_marker="$unsafe_root/process-launcher-called"
  victim="$unsafe_root/victim"
  logf="$unsafe_root/protocol.log"
  case "$unsafe_kind" in
    symlink)
      printf 'symlink victim\n' > "$victim"
      ln -s -- "$victim" "$logf"
      ;;
    hardlink)
      printf 'hardlink victim\n' > "$victim"
      ln -- "$victim" "$logf"
      ;;
    fifo)
      mkfifo -- "$logf"
      ;;
  esac
  if (
    OUT_DIR="$unsafe_root"
    diag_process_group_start() {
      : > "$launcher_marker"
      return 0
    }
    diag_process_group_wait() { return 0; }
    run_pinned_protocol_logged "$unsafe_root/canonical.output" "$logf" \
      mocked-pinned-runner
  ); then
    unsafe_log_rc=0
  else
    unsafe_log_rc=$?
  fi
  check_true "pinned protocol rejects a $unsafe_kind log destination" \
    test "$unsafe_log_rc" -ne 0
  check_true "pinned protocol rejects $unsafe_kind before process launch" \
    test ! -e "$launcher_marker"
  if [[ "$unsafe_kind" != fifo ]]; then
    check_eq "pinned protocol leaves the $unsafe_kind victim unchanged" \
      "$unsafe_kind victim" "$(cat -- "$victim")"
  fi
done

echo '== fresh pinned metadata durability =='
FRESH_META_ROOT="$TMP_ROOT/pinned-fresh-meta"
FRESH_META_EVENTS="$FRESH_META_ROOT/events"
FRESH_META_GENERATION=33333333333333333333333333333333
mkdir -p -- "$FRESH_META_ROOT/results" "$FRESH_META_ROOT/state" "$FRESH_META_ROOT/logs"
: > "$FRESH_META_EVENTS"
if (
  OUT_DIR="$FRESH_META_ROOT"
  STATE_DIR="$FRESH_META_ROOT/state"
  RUN_SCHEMA_VERSION=2
  PINNED_CONCURRENT_ROUNDS=1
  PROTOCOL_SEED=9
  INDIVIDUAL_GROUP_GENERATION=44444444444444444444444444444444
  INDIVIDUAL_GROUP_PLAN_DIGEST=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
  ONLINE_CPUS=0-1
  CONCURRENT_NAME=(context-a)
  DIAG_INDIVIDUAL_NODE_BIN=fake_generation_node
  metadata_file_synced=0
  metadata_dir_synced=0

  record_fresh_meta() { printf '%s\n' "$1" >> "$FRESH_META_EVENTS"; }
  diag_log() { :; }
  diag_warn() { :; }
  diag_log_cmd() { :; }
  pinned_contexts_prepare() { return 0; }
  bundle_prepare_dir() {
    mkdir -p -- "$OUT_DIR/$1"
  }
  fake_generation_node() {
    printf '%s\n' "$FRESH_META_GENERATION"
  }
  node() {
    local output="" previous="" argument
    case "${2:-}" in
      plan-concurrent) return 0 ;;
      build-meta)
        for argument in "$@"; do
          if [[ "$previous" == --output ]]; then output="$argument"; fi
          previous="$argument"
        done
        [[ -n "$output" ]] || return 97
        record_fresh_meta meta-write
        printf 'GENERATION=%s\nCOMPLETED=0\n' "$FRESH_META_GENERATION" > "$output"
        ;;
      validate-before)
        record_fresh_meta validate-before
        ((metadata_file_synced == 1 && metadata_dir_synced == 1))
        ;;
      next-concurrent)
        record_fresh_meta next-concurrent
        ((metadata_file_synced == 1 && metadata_dir_synced == 1)) || return 97
        printf '{"committedWaves":0,"complete":false,"controllerCpu":1}\n'
        ;;
      *)
        record_fresh_meta "forbidden-node:${2:-missing-command}"
        return 97
        ;;
    esac
  }
  sync() {
    if (($# != 2)) || [[ "$1" != -f ]]; then
      record_fresh_meta "unexpected-sync-argv:$*"
      return 97
    fi
    local target="$2"
    case "$target" in
      "$OUT_DIR/results/pinned-concurrent.tsv") return 0 ;;
      "$OUT_DIR/results/pinned-concurrent.meta")
        record_fresh_meta sync-meta
        [[ -f "$target" && ! -L "$target" ]] || return 97
        metadata_file_synced=1
        ;;
      "$OUT_DIR/results")
        record_fresh_meta sync-results-dir
        ((metadata_file_synced == 1)) || return 97
        metadata_dir_synced=1
        ;;
      *)
        record_fresh_meta "unexpected-sync:$target"
        return 97
        ;;
    esac
  }
  telemetry_resumable_prepare_descriptive() {
    record_fresh_meta telemetry-prepare
    ((metadata_file_synced == 1 && metadata_dir_synced == 1)) || return 97
    TELEMETRY_RESUME_AVAILABLE=1
    TELEMETRY_RESUME_NEXT_SEGMENT=1
    TELEMETRY_RESUME_SEGMENTS_JSON='[]'
  }
  telemetry_sampler_start() {
    record_fresh_meta telemetry-start
    ((metadata_file_synced == 1 && metadata_dir_synced == 1)) || return 97
    return 96
  }
  telemetry_boundary_start() { record_fresh_meta forbidden-telemetry-boundary; return 97; }
  run_pinned_protocol_logged() { record_fresh_meta forbidden-workload-launch; return 97; }

  phase_pinned_concurrent
) > "$FRESH_META_ROOT/phase.output" 2>&1; then
  fresh_meta_phase_rc=0
else
  fresh_meta_phase_rc=$?
fi
check_true 'fresh phase stops at the mocked pre-workload telemetry boundary' \
  test "$fresh_meta_phase_rc" -ne 0
fresh_meta_events="$(cat -- "$FRESH_META_EVENTS")"
check_eq 'fresh incomplete metadata is durable before validation, progress, and telemetry' \
  $'meta-write\nsync-meta\nsync-results-dir\nvalidate-before\nnext-concurrent\ntelemetry-prepare\ntelemetry-start' \
  "$fresh_meta_events"
if grep -q '^forbidden-' "$FRESH_META_EVENTS" ||
  grep -q '^unexpected-' "$FRESH_META_EVENTS"; then
  bad 'fresh metadata durability test reaches no workload or unexpected boundary'
else
  ok 'fresh metadata durability test reaches no workload or unexpected boundary'
fi

echo '== pinned-concurrent terminal publication ordering =='
PUBLISH_ROOT="$TMP_ROOT/pinned-terminal-publish"
PUBLISH_EVENTS="$PUBLISH_ROOT/events"
PUBLISH_GENERATION=0123456789abcdef0123456789abcdef
mkdir -p -- "$PUBLISH_ROOT/results" "$PUBLISH_ROOT/state/pinned-concurrent-waves" \
  "$PUBLISH_ROOT/logs/pinned-concurrent"
cat > "$PUBLISH_ROOT/results/pinned-concurrent.meta" <<EOF
GENERATION=$PUBLISH_GENERATION
COMPLETED=0
EOF
printf 'prefix\n' > "$PUBLISH_ROOT/results/pinned-concurrent.tsv"
printf 'groups\n' > "$PUBLISH_ROOT/results/pinned-concurrent.groups.tsv"
printf 'plan\n' > "$PUBLISH_ROOT/results/pinned-concurrent.plan.tsv"
: > "$PUBLISH_EVENTS"
(
  OUT_DIR="$PUBLISH_ROOT"
  STATE_DIR="$PUBLISH_ROOT/state"
  RUN_SCHEMA_VERSION=2
  PINNED_CONCURRENT_ROUNDS=1
  PROTOCOL_SEED=7
  INDIVIDUAL_GROUP_GENERATION=11111111111111111111111111111111
  INDIVIDUAL_GROUP_PLAN_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  ONLINE_CPUS=0-1
  CONCURRENT_NAME=(context-a)
  TELEMETRY_RESUME_AVAILABLE=0
  TELEMETRY_RESUME_SEGMENTS_JSON='[]'
  publication_violation=0
  results_moved=0
  boundaries_moved=0
  sidecars_dir_synced=0
  meta_moved=0
  meta_synced=0
  meta_dir_synced=0

  record_publish() { printf '%s\n' "$1" >> "$PUBLISH_EVENTS"; }
  diag_log() { :; }
  diag_warn() { :; }
  diag_log_cmd() { :; }
  bundle_prepare_dir() { return 0; }
  pinned_contexts_prepare() { return 0; }
  pinned_concurrent_plan_matches_topology() { return 0; }
  telemetry_resumable_prepare_descriptive() {
    TELEMETRY_RESUME_AVAILABLE=0
    TELEMETRY_RESUME_SEGMENTS_JSON='[]'
  }
  telemetry_sampler_start() { record_publish forbidden-telemetry-start; return 97; }
  run_pinned_protocol_logged() { record_publish forbidden-workload-launch; return 97; }
  pinned_concurrent_evidence_is_complete() { return 0; }
  mark_done() { record_publish marker; }

  node() {
    case "${2:-}" in
      validate-complete)
        grep -Fqx 'COMPLETED=1' \
          "$OUT_DIR/results/pinned-concurrent.meta" 2>/dev/null
        ;;
      validate-before) return 0 ;;
      next-concurrent)
        printf '{"committedWaves":1,"complete":true}\n'
        ;;
      *)
        record_publish "forbidden-node:${2:-missing-command}"
        return 97
        ;;
    esac
  }

  pinned_concurrent_final_stage_prepare() {
    local stage="$1"
    record_publish stage-prepare
    mkdir -- "$stage"
    printf 'complete results\n' > "$stage/pinned-concurrent.tsv"
    printf 'complete boundaries\n' > "$stage/pinned-concurrent.boundaries.ndjson"
    cat > "$stage/pinned-concurrent.meta" <<EOF
GENERATION=$PUBLISH_GENERATION
COMPLETED=1
EOF
  }

  mv() {
    local destination="${@: -1}"
    case "$destination" in
      "$OUT_DIR/results/pinned-concurrent.tsv")
        record_publish mv-results
        results_moved=1
        ;;
      "$OUT_DIR/results/pinned-concurrent.boundaries.ndjson")
        record_publish mv-boundaries
        boundaries_moved=1
        ;;
      "$OUT_DIR/results/pinned-concurrent.meta")
        record_publish mv-meta
        ((results_moved == 1 && boundaries_moved == 1 && sidecars_dir_synced == 1)) ||
          publication_violation=1
        meta_moved=1
        ;;
      *)
        record_publish "unexpected-mv:$destination"
        publication_violation=1
        ;;
    esac
    command mv "$@"
  }

  sync() {
    local target="${@: -1}"
    case "$target" in
      "$OUT_DIR/results/pinned-concurrent.tsv")
        record_publish sync-results
        ((results_moved == 1 && meta_moved == 0)) || publication_violation=1
        ;;
      "$OUT_DIR/results/pinned-concurrent.boundaries.ndjson")
        record_publish sync-boundaries
        ((boundaries_moved == 1 && meta_moved == 0)) || publication_violation=1
        ;;
      "$OUT_DIR/results/pinned-concurrent.meta")
        record_publish sync-meta
        ((meta_moved == 1 && sidecars_dir_synced == 1)) || publication_violation=1
        meta_synced=1
        ;;
      "$OUT_DIR/results")
        record_publish sync-results-dir
        if ((meta_moved == 0)); then
          ((results_moved == 1 && boundaries_moved == 1)) || publication_violation=1
          sidecars_dir_synced=1
        else
          ((meta_synced == 1)) || publication_violation=1
          meta_dir_synced=1
        fi
        ;;
      *)
        record_publish "unexpected-sync:$target"
        publication_violation=1
        ;;
    esac
  }

  protocol_finalize_stage_close() {
    record_publish stage-close
    ((meta_dir_synced == 1)) || publication_violation=1
    rmdir -- "$1"
  }

  phase_pinned_concurrent
  ((publication_violation == 0 && results_moved == 1 && boundaries_moved == 1 &&
    sidecars_dir_synced == 1 && meta_moved == 1 && meta_synced == 1 &&
    meta_dir_synced == 1))
)
terminal_publish_rc=$?
check_eq 'mocked complete protocol reaches terminal publication without workload launch' \
  0 "$terminal_publish_rc"
terminal_publish_events="$(cat -- "$PUBLISH_EVENTS")"
check_eq 'sidecars and directory are durable before complete metadata publication' \
  $'stage-prepare\nmv-results\nmv-boundaries\nsync-results\nsync-boundaries\nsync-results-dir\nmv-meta\nsync-meta\nsync-results-dir\nstage-close\nmarker' \
  "$terminal_publish_events"
if grep -q '^forbidden-' "$PUBLISH_EVENTS"; then
  bad 'terminal publication test crosses no workload, telemetry, or unknown Node boundary'
else
  ok 'terminal publication test crosses no workload, telemetry, or unknown Node boundary'
fi

echo '== immutable incomplete-phase configuration =='
CONFIG_ROOT="$TMP_ROOT/config-redo"
mkdir -p -- "$CONFIG_ROOT/results" "$CONFIG_ROOT/state"
cat > "$CONFIG_ROOT/results/meta.env" <<'EOF'
GROUP_WAVES=4
CPU_TARGET=auto
EOF
printf 'partial group row\n' > "$CONFIG_ROOT/results/groups.tsv"
config_output="$CONFIG_ROOT/rejected.output"
if (
  OUT_DIR="$CONFIG_ROOT"
  STATE_DIR="$CONFIG_ROOT/state"
  RESUME_DIR="$CONFIG_ROOT"
  GROUP_WAVES=5
  GROUP_WAVES_EXPLICIT=1
  REDO_PLAN=()
  validate_completed_phase_overrides
) > "$config_output" 2>&1; then
  config_reject_rc=0
else
  config_reject_rc=$?
fi
check_true 'changed immutable config rejects incomplete evidence without redo' \
  test "$config_reject_rc" -ne 0
check_true 'immutable-config rejection names the required redo phase' \
  grep -Fq 'changes incomplete groups evidence; resume with --redo groups' "$config_output"
(
  OUT_DIR="$CONFIG_ROOT"
  STATE_DIR="$CONFIG_ROOT/state"
  RESUME_DIR="$CONFIG_ROOT"
  GROUP_WAVES=5
  GROUP_WAVES_EXPLICIT=1
  REDO_PLAN=(groups)
  validate_completed_phase_overrides
)
config_redo_rc=$?
check_eq 'explicit redo authorizes the incomplete-phase config change' 0 "$config_redo_rc"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
