#!/usr/bin/env bash
# Capture pristine SIGSEGV fault context from child.mjs pinned to one CPU.
# Stops the fault before Node's trap handler runs (handle SIGSEGV stop nopass)
# and records backtrace, registers, faulting instruction, explicitly labelled
# si_addr/CR2 values, threads, and proc mappings. Every run is piped through
# diagnose-lib/gdb-attempt-io.mjs, which bounds the stream, classifies it, and
# publishes provenance-bound transcripts: clean runs leave no file, captured
# and error runs keep cpu<CPU>-run<RUN>.txt, and an over-limit stream becomes
# a truncated error transcript that is never counted as a capture.
#
# Usage: ./capture-fault.sh <cpu> <max-runs> <max-captures> <out-dir> <generation> [node-bin]
#
# The optional node-bin selects the exact executable that runs child.mjs under
# GDB. It must be an absolute path; it is resolved to a canonical executable
# regular file before use. Without it the debug target is the PATH-resolved
# node, exactly as before. The transcript helper itself always runs under the
# PATH-resolved node.
#
# stdout is authoritative runner evidence: exactly one
#   ATTEMPT\tGENERATION\t<gen>\tCPU\t<cpu>\tMAX_RUNS\t<n>\tMAX_CAPTURES\t<m>\tRUN\t<r>\tOUTCOME\t<clean|captured|error>
# record per attempt, followed by exactly one terminal
#   COUNTS\tGENERATION\t<gen>\tCPU\t<cpu>\tMAX_RUNS\t<n>\tMAX_CAPTURES\t<m>\tATTEMPTED\t<a>\tCLEAN\t<c>\tCAPTURED\t<k>\tERRORS\t<e>\tEXIT_CODE\t<rc>
# record. Nothing else may appear on stdout; human progress goes to stderr.
# A run that cannot complete its terminal accounting (runner failure, helper
# failure, interruption) exits without a COUNTS record, which keeps the log
# unpublishable. diagnose-lib/gdb-evidence.mjs owns the exact grammar.
#
# Exit codes:
#   0  at least one fault captured (stop at the capture cap or run exhaustion)
#   2  usage error
#   3  no fault within the run limit (at least one clean run observed)
#   4  missing dependency
#   5  runner failure (no run executed the workload successfully, or the
#      transcript helper failed); never publishable
set -u
ulimit -c 0

if [[ $# -lt 5 || $# -gt 6 ]]; then
  echo "usage: capture-fault.sh <cpu> <max-runs> <max-captures> <out-dir> <generation> [node-bin]" >&2
  exit 2
fi
cpu="$1"
max_runs="$2"
max_captures="$3"
out_dir="$4"
generation="$5"
node_bin_arg="${6:-}"

for v in cpu max_runs max_captures; do
  if [[ ! "${!v}" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "error: $v must be a canonical non-negative integer, got '${!v}'" >&2
    exit 2
  fi
done
# Match the attempt helper's argument domain so invalid invocations fail as
# usage errors here instead of runner failures downstream.
if [[ "$cpu" -gt 65535 ]]; then
  echo "error: cpu must be at most 65535, got '$cpu'" >&2
  exit 2
fi
for v in max_runs max_captures; do
  if [[ "${!v}" -eq 0 ]]; then
    echo "error: $v must be positive, got '${!v}'" >&2
    exit 2
  fi
done
if [[ ! "$generation" =~ ^[0-9a-f]{32}$ ]]; then
  echo "error: generation must be 32 lowercase hex characters, got '$generation'" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || {
  echo "error: cannot resolve the script directory" >&2
  exit 4
}
attempt_helper="$script_dir/diagnose-lib/gdb-attempt-io.mjs"

for dep in gdb taskset timeout; do
  if ! command -v "$dep" > /dev/null 2>&1; then
    echo "error: missing dependency: $dep" >&2
    exit 4
  fi
done
node_bin="$(command -v node)" || {
  echo "error: missing dependency: node" >&2
  exit 4
}
# The debug target defaults to the PATH-resolved node. An explicit node-bin
# must be absolute and is resolved once, here, so the exact target executable
# is fixed before the first attempt and never re-derived from PATH.
node_target="$node_bin"
if [[ -n "$node_bin_arg" ]]; then
  if [[ "$node_bin_arg" != /* ]]; then
    echo "error: node-bin must be an absolute path, got '$node_bin_arg'" >&2
    exit 2
  fi
  node_target="$(readlink -f -- "$node_bin_arg")" || {
    echo "error: cannot resolve node-bin '$node_bin_arg'" >&2
    exit 2
  }
  if [[ ! -f "$node_target" || ! -x "$node_target" ]]; then
    echo "error: node-bin is not an executable regular file: '$node_bin_arg'" >&2
    exit 2
  fi
fi
if [[ ! -f child.mjs ]]; then
  echo "error: child.mjs not found in the current directory" >&2
  exit 4
fi
if [[ ! -f "$attempt_helper" ]]; then
  echo "error: missing dependency: diagnose-lib/gdb-attempt-io.mjs" >&2
  exit 4
fi

mkdir -p "$out_dir" || {
  echo "error: cannot create $out_dir" >&2
  exit 5
}

captures=0
clean_runs=0
error_runs=0

emit_attempt() {
  local run="$1" outcome="$2"
  printf 'ATTEMPT\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tRUN\t%s\tOUTCOME\t%s\n' \
    "$generation" "$cpu" "$max_runs" "$max_captures" "$run" "$outcome"
}

emit_counts() {
  local attempted="$1" rc="$2"
  printf 'COUNTS\tGENERATION\t%s\tCPU\t%s\tMAX_RUNS\t%s\tMAX_CAPTURES\t%s\tATTEMPTED\t%s\tCLEAN\t%s\tCAPTURED\t%s\tERRORS\t%s\tEXIT_CODE\t%s\n' \
    "$generation" "$cpu" "$max_runs" "$max_captures" \
    "$attempted" "$clean_runs" "$captures" "$error_runs" "$rc"
}

for ((run = 1; run <= max_runs; run++)); do
  # The helper prints exactly one outcome token on stdout. Its token and the
  # pipeline element statuses are captured together; the statuses ride a
  # sentinel line appended after the helper exits. A producer killed by
  # SIGPIPE after the helper cut the stream off at the evidence limit is the
  # helper-owned overflow below, never a capture.
  outcome_and_status="$(
    {
      {
        printf '# capture-fault.sh cpu=%s run=%s started=%s node=%s\n' "$cpu" "$run" "$(date -Is)" "$node_target"
        printf '# affinity: '
        taskset -pc $$ 2>/dev/null || printf 'unknown\n'
        timeout --foreground --signal=KILL 180 taskset -c "$cpu" gdb --batch \
          -ex "set pagination off" \
          -ex "set width 0" \
          -ex "set debuginfod enabled off" \
          -ex "handle SIGSEGV stop nopass" \
          -ex "run" \
          -ex "bt 20" \
          -ex "info registers" \
          -ex "x/2i \$pc" \
          -ex "printf \"SI_ADDR=%p\n\", (void*)\$_siginfo._sifields._sigfault.si_addr" \
          -ex "printf \"CR2=%p\n\", (void*)\$cr2" \
          -ex "info threads" \
          -ex "info proc mappings" \
          -ex "printf \"MAPPINGS_COMPLETE=1\\n\"" \
          --args "$node_target" child.mjs
      } 2>&1 |
        "$node_bin" "$attempt_helper" \
          "$out_dir" "$generation" "$cpu" "$max_runs" "$max_captures" "$run"
      printf '__PIPESTATUS__%s %s\n' "${PIPESTATUS[0]}" "${PIPESTATUS[1]}"
    }
  )"
  helper_outcome=""
  if [[ "$outcome_and_status" == *$'\n'* ]]; then
    helper_outcome="${outcome_and_status%%$'\n'*}"
  fi
  status_line="${outcome_and_status##*$'\n'}"
  if [[ ! "$status_line" =~ ^__PIPESTATUS__([0-9]+)\ ([0-9]+)$ ]]; then
    echo "error: run=${run} transcript helper did not report pipeline status; aborting" >&2
    exit 5
  fi
  producer_rc="${BASH_REMATCH[1]}"
  helper_rc="${BASH_REMATCH[2]}"
  case "$helper_rc:$helper_outcome" in
    0:clean) outcome=clean ;;
    0:captured) outcome=captured ;;
    0:error | 0:overflow) outcome=error ;;
    *)
      echo "error: run=${run} transcript helper failed (helper rc=${helper_rc}, producer rc=${producer_rc}); aborting" >&2
      exit 5
      ;;
  esac
  emit_attempt "$run" "$outcome"

  case "$outcome" in
    captured)
      captures=$((captures + 1))
      echo "run=${run} cpu=${cpu} CAPTURED (cpu${cpu}-run${run}.txt)" >&2
      if [ "$captures" -ge "$max_captures" ]; then
        echo "done: ${captures} capture(s) after ${run} run(s)" >&2
        emit_counts "$run" 0
        exit 0
      fi
      ;;
    clean)
      clean_runs=$((clean_runs + 1))
      echo "run=${run} cpu=${cpu} clean" >&2
      ;;
    error)
      error_runs=$((error_runs + 1))
      if [[ "$helper_outcome" == overflow ]]; then
        echo "run=${run} cpu=${cpu} ERROR (output exceeded the evidence limit; truncated transcript kept: cpu${cpu}-run${run}.txt)" >&2
      else
        echo "run=${run} cpu=${cpu} ERROR (transcript kept: cpu${cpu}-run${run}.txt)" >&2
      fi
      ;;
  esac
done

if [ "$captures" -gt 0 ]; then
  echo "done: ${captures} capture(s) after ${max_runs} run(s)" >&2
  emit_counts "$max_runs" 0
  exit 0
fi
if [ "$clean_runs" -eq 0 ]; then
  echo "error: no run executed the workload successfully (${error_runs} error run(s))" >&2
  exit 5
fi
echo "done: 0 captures after ${max_runs} run(s) (${clean_runs} clean, ${error_runs} errors)" >&2
emit_counts "$max_runs" 3
exit 3
