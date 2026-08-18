#!/usr/bin/env bash
# External-load A/B/A harness for the native trigger (repro-c), mirroring the
# Node recipe from load-state-aba.mjs: target pinned to one logical CPU,
# leg B adds one verified /usr/bin/yes worker per selected load CPU, disjoint
# from the target. The harness process itself is pinned away from the target.
#
# Usage: repro-c-aba.sh [target-cpu] [runs-per-leg] [load-cpus] [mode]
#   target-cpu    logical CPU id (default 19)
#   runs-per-leg  repetitions per leg (default 20)
#   load-cpus     taskset CPU list for leg B (default 0-7, the P-cores)
#   mode          repro-c mode: clone (default) or rmw
#
# repro-c exit codes: 0 pass, 42 SIGSEGV captured, 43 data mismatch.
set -u
ulimit -c 0

TARGET="${1:-19}"
RUNS="${2:-20}"
LOAD_CPUS="${3:-0-7}"
MODE="${4:-clone}"
SETTLE=15
BIN=./repro-c
SRC=repro-c.c

if [[ ! "$TARGET" =~ ^(0|[1-9][0-9]*)$ ]]; then
  printf 'usage: %s [target-cpu] [runs-per-leg] [load-cpus]\n' "$0" >&2
  exit 2
fi
if [[ ! "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'error: runs-per-leg must be a positive integer, got %s\n' "$RUNS" >&2
  exit 2
fi

for dep in cc taskset yes; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    printf 'error: missing dependency: %s\n' "$dep" >&2
    exit 2
  fi
done

if [[ ! -x "$BIN" || "$SRC" -nt "$BIN" ]]; then
  echo "building $BIN ..."
  cc -O2 -Wall -Wextra -pthread -o "$BIN" "$SRC" || exit 1
fi

# Expand "0-3,7" style lists to individual CPU ids, one per line.
expand_cpus() {
  local tok i
  for tok in ${1//,/ }; do
    if [[ "$tok" == *-* ]]; then
      for ((i = ${tok%-*}; i <= ${tok#*-}; i++)); do printf '%s\n' "$i"; done
    else
      printf '%s\n' "$tok"
    fi
  done
}
mapfile -t LOAD_LIST < <(expand_cpus "$LOAD_CPUS")

# Keep the harness off the target CPU (the Node harness used CPU 8 as
# controller); best effort only.
if [[ "$TARGET" != "8" ]]; then
  taskset -pc 8 $$ >/dev/null 2>&1 || true
fi

WORKER_PIDS=()
cleanup() {
  if ((${#WORKER_PIDS[@]} > 0)); then
    kill "${WORKER_PIDS[@]}" 2>/dev/null
    wait "${WORKER_PIDS[@]}" 2>/dev/null
  fi
}
trap cleanup EXIT

start_workers() {
  local pid want got
  for want in "${LOAD_LIST[@]}"; do
    [[ "$want" == "$TARGET" ]] && continue
    taskset -c "$want" yes >/dev/null &
    pid=$!
    WORKER_PIDS+=("$pid")
  done
  # Verify every worker's affinity through /proc before measuring.
  sleep 0.3
  local i
  for i in "${!WORKER_PIDS[@]}"; do
    pid=${WORKER_PIDS[$i]}
    want=${LOAD_LIST[$i]}
    [[ "$want" == "$TARGET" ]] && continue
    got=$(grep '^Cpus_allowed_list:' "/proc/$pid/status" 2>/dev/null | awk '{print $2}')
    if [[ "$got" != "$want" ]]; then
      printf 'error: worker pid=%s affinity=%s, want %s\n' "$pid" "$got" "$want" >&2
      exit 1
    fi
  done
  printf 'load workers: %d x /usr/bin/yes on CPUs %s (verified via /proc)\n' \
    "${#WORKER_PIDS[@]}" "$LOAD_CPUS"
}

stop_workers() {
  cleanup
  WORKER_PIDS=()
}

# run_leg <name> <description>  — counts into globals via nameref
run_leg() {
  local leg="$1" desc="$2"
  local pass=0 segv=0 mismatch=0 other=0 rc r out
  printf -- '--- leg %s: %s (%d runs on CPU %s) ---\n' "$leg" "$desc" "$RUNS" "$TARGET"
  for ((r = 1; r <= RUNS; r++)); do
    out=$(taskset -c "$TARGET" "$BIN" --mode "$MODE" 2>&1)
    rc=$?
    case $rc in
      0) ((pass += 1)) ;;
      *)
        printf '[%s run %s] rc=%s\n' "$leg" "$r" "$rc"
        case $rc in
          42) ((segv += 1)) ;;
          43) ((mismatch += 1)) ;;
          *) ((other += 1)) ;;
        esac
        printf '%s\n' "$out" | sed "s/^/[${leg} run ${r}] /"
        ;;
    esac
  done
  printf 'leg %s: pass=%d sigsegv=%d mismatch=%d other=%d\n' \
    "$leg" "$pass" "$segv" "$mismatch" "$other"
  LEG_RES+=("$leg|$desc|$RUNS|$pass|$segv|$mismatch|$other")
}

printf 'repro-c-aba: mode=%s target=%s runs-per-leg=%s load-cpus=%s kernel=%s\n' \
  "$MODE" "$TARGET" "$RUNS" "$LOAD_CPUS" "$(uname -r)"
"$BIN" --mode rmw --iters 1 --batch 1 --span-mb 0 >/dev/null 2>&1 || {
  printf 'error: %s smoke test failed\n' "$BIN" >&2
  exit 1
}

LEG_RES=()

run_leg A1 "no induced load"
start_workers
run_leg B "induced load (yes on CPUs $LOAD_CPUS)"
stop_workers
printf 'settling %ds before recovery leg ...\n' "$SETTLE"
sleep "$SETTLE"
run_leg A2 "no induced load after recovery"

printf '\n| Leg | Condition | Runs | Pass | SIGSEGV | Mismatch | Other |\n'
printf '| --- | --- | ---: | ---: | ---: | ---: | ---: |\n'
total_faults=0
for row in "${LEG_RES[@]}"; do
  IFS='|' read -r leg desc runs pass segv mismatch other <<<"$row"
  printf '| %s | %s | %s | %s | %s | %s | %s |\n' \
    "$leg" "$desc" "$runs" "$pass" "$segv" "$mismatch" "$other"
  ((total_faults += segv + mismatch))
done

((total_faults == 0))
