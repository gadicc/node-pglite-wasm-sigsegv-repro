#!/usr/bin/env bash
# Capture pristine SIGSEGV fault context from child.mjs pinned to one CPU.
# Stops the fault before Node's trap handler runs (handle SIGSEGV stop nopass)
# and records backtrace, registers, faulting instruction, si_addr, threads,
# and proc mappings. Transcripts of clean runs are deleted.
#
# Usage: ./capture-fault.sh <cpu> <max-runs> <max-captures> <out-dir>
set -u

cpu="${1:?usage: capture-fault.sh <cpu> <max-runs> <max-captures> <out-dir>}"
max_runs="${2:?}"
max_captures="${3:?}"
out_dir="${4:?}"
mkdir -p "$out_dir"

node_bin="$(command -v node)"
captures=0

for ((run = 1; run <= max_runs; run++)); do
  out="$out_dir/cpu${cpu}-run${run}.txt"
  timeout --signal=KILL 180 taskset -c "$cpu" gdb --batch \
    -ex "set pagination off" \
    -ex "set width 0" \
    -ex "handle SIGSEGV stop nopass" \
    -ex "run" \
    -ex "bt 20" \
    -ex "info registers" \
    -ex "x/2i \$pc" \
    -ex "p/x (unsigned long)\$_siginfo._sifields._sigfault.si_addr" \
    -ex "info threads" \
    -ex "info proc mappings" \
    --args "$node_bin" child.mjs > "$out" 2>&1
  if grep -q "received signal SIGSEGV" "$out"; then
    captures=$((captures + 1))
    echo "run=${run} cpu=${cpu} CAPTURED ($out)"
    if [ "$captures" -ge "$max_captures" ]; then
      echo "done: ${captures} capture(s) after ${run} run(s)"
      exit 0
    fi
  else
    rm -f "$out"
    echo "run=${run} cpu=${cpu} clean"
  fi
done
echo "done: ${captures} capture(s) after ${max_runs} run(s)"
