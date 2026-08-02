#!/usr/bin/env bash
# Capture pristine SIGSEGV fault context from child.mjs pinned to one CPU.
# Stops the fault before Node's trap handler runs (handle SIGSEGV stop nopass)
# and records backtrace, registers, faulting instruction, explicitly labelled
# si_addr/CR2 values, threads, and proc mappings. Transcripts of clean runs are deleted;
# transcripts of capture and runner-error runs are kept.
#
# Usage: ./capture-fault.sh <cpu> <max-runs> <max-captures> <out-dir>
#
# Exit codes:
#   0  at least one fault captured
#   2  usage error
#   3  no fault within the run limit (at least one clean run observed)
#   4  missing dependency
#   5  runner failure (no run executed the workload successfully)
set -u
ulimit -c 0

if [[ $# -ne 4 ]]; then
  echo "usage: capture-fault.sh <cpu> <max-runs> <max-captures> <out-dir>" >&2
  exit 2
fi
cpu="$1"
max_runs="$2"
max_captures="$3"
out_dir="$4"

for v in cpu max_runs max_captures; do
  if [[ ! "${!v}" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "error: $v must be a canonical non-negative integer, got '${!v}'" >&2
    exit 2
  fi
done

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
if [[ ! -f child.mjs ]]; then
  echo "error: child.mjs not found in the current directory" >&2
  exit 4
fi

mkdir -p "$out_dir" || {
  echo "error: cannot create $out_dir" >&2
  exit 5
}

captures=0
clean_runs=0
error_runs=0

emit_run_counts() {
  local attempted="$1"
  printf 'GDB_RUN_COUNTS attempted=%s clean=%s captured=%s errors=%s\n' \
    "$attempted" "$clean_runs" "$captures" "$error_runs"
}

for ((run = 1; run <= max_runs; run++)); do
  out="$out_dir/cpu${cpu}-run${run}.txt"
  {
    printf '# capture-fault.sh cpu=%s run=%s started=%s\n' "$cpu" "$run" "$(date -Is)"
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
      --args "$node_bin" child.mjs
  } > "$out" 2>&1

  if grep -q "received signal SIGSEGV" "$out"; then
    captures=$((captures + 1))
    echo "run=${run} cpu=${cpu} CAPTURED (${out##*/})"
    if [ "$captures" -ge "$max_captures" ]; then
      echo "done: ${captures} capture(s) after ${run} run(s)"
      emit_run_counts "$run"
      exit 0
    fi
  elif grep -q "exited normally" "$out"; then
    clean_runs=$((clean_runs + 1))
    rm -f "$out"
    echo "run=${run} cpu=${cpu} clean"
  else
    error_runs=$((error_runs + 1))
    echo "run=${run} cpu=${cpu} ERROR (transcript kept: ${out##*/})" >&2
  fi
done

if [ "$captures" -gt 0 ]; then
  echo "done: ${captures} capture(s) after ${max_runs} run(s)"
  emit_run_counts "$max_runs"
  exit 0
fi
if [ "$clean_runs" -eq 0 ]; then
  echo "error: no run executed the workload successfully (${error_runs} error run(s))" >&2
  emit_run_counts "$max_runs"
  exit 5
fi
echo "done: 0 captures after ${max_runs} run(s) (${clean_runs} clean, ${error_runs} errors)"
emit_run_counts "$max_runs"
exit 3
