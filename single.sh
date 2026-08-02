#!/usr/bin/env bash
# Run child.mjs pinned to one logical CPU, repeatedly.
#
# Usage: single.sh [cpu] [runs] [tsv-file] [first-run]
#   cpu       logical CPU id (default 19)
#   runs      number of repetitions (default 20)
#   tsv-file  optional; append "cpu<TAB>run<TAB>rc<TAB>elapsed_sec" lines
#   first-run start the recorded run ids here (default 1; used for resume)
#
# Plain invocation `single.sh` behaves exactly as before: 20 runs on CPU 19
# with human-readable progress. Core dumps are disabled for the child.
set -u
ulimit -c 0

CPU="${1:-19}"
RUNS="${2:-20}"
TSV_FILE="${3:-}"
FIRST_RUN="${4:-1}"

if [[ ! "$CPU" =~ ^(0|[1-9][0-9]*)$ ]]; then
  printf 'usage: %s [cpu] [runs] [tsv-file]\n' "$0" >&2
  exit 2
fi
if [[ ! "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'error: runs must be a positive integer, got %s\n' "$RUNS" >&2
  exit 2
fi
if [[ ! "$FIRST_RUN" =~ ^[1-9][0-9]*$ ]]; then
  printf 'error: first-run must be a positive integer, got %s\n' "$FIRST_RUN" >&2
  exit 2
fi
echo "Checking CPU $CPU ($RUNS runs)..."

pass=0
fail=0

for ((offset = 0; offset < RUNS; offset++)); do
  run=$((FIRST_RUN + offset))
  printf '%02d... ' "$run"

  start=$SECONDS
  taskset -c "$CPU" node child.mjs
  rc=$?
  elapsed=$((SECONDS - start))

  if [[ -n "$TSV_FILE" ]]; then
    printf '%s\t%s\t%s\t%s\n' "$CPU" "$run" "$rc" "$elapsed" >> "$TSV_FILE"
  fi

  if ((rc == 0)); then
    ((pass += 1))
    echo "ok"
  else
    ((fail += 1))
    if ((rc > 128)); then
      printf 'FAIL rc=%d signal=%d\n' "$rc" "$((rc - 128))"
    else
      printf 'FAIL rc=%d\n' "$rc"
    fi
  fi
done

printf 'passed=%d failed=%d\n' "$pass" "$fail"
((fail == 0))
