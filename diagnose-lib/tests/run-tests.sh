#!/usr/bin/env bash
# run-tests.sh - test suite for the diagnostic runner tooling.
#
# Covers: CPU-list parsing, settings restore on SIGINT/SIGTERM/normal exit,
# script argument validation and exit codes, statistics, log/capture
# parsing, and an end-to-end collect+report run on a synthetic bundle.
# Nothing here runs the actual crash workload.
set -u

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/diagnose-lib"
FIX="$LIB/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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

check_eq() {
  # check_eq <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else
    bad "$1 (expected [$2], got [$3])"
  fi
}

# shellcheck source=../common.sh
source "$LIB/common.sh"

echo "== cpulist helpers =="
check_eq "expand ranges" $'0\n1\n2\n3\n8\n10\n11' "$(diag_cpulist_expand '0-3,8,10-11')"
check_eq "expand single" "5" "$(diag_cpulist_expand '5')"
check_eq "compress" "0-3,8,10-11" "$(diag_cpulist_expand '0-3,8,10-11' | sort -n | diag_cpulist_compress)"
check_eq "compress single" "5" "$(printf '5\n' | diag_cpulist_compress)"
check_eq "count" "24" "$(diag_cpulist_count '0-23')"
if (diag_cpulist_expand 'bogus') 2> /dev/null; then
  bad "expand rejects garbage"
else
  ok "expand rejects garbage"
fi

echo "== settings restore on simulated interruption =="
run_restore_case() {
  # run_restore_case <signal|EXIT> ; echoes final fake-file content
  local sig="$1"
  local dir
  dir="$(mktemp -d "$TMP/restore.XXXXXX")"
  printf '0\n' > "$dir/no_turbo"
  bash "$FIX/restore-child.sh" "$REPO_ROOT" "$dir/restore.tsv" "$dir/no_turbo" "$dir/ready" \
    $([[ "$sig" == "EXIT" ]] && printf 'exit-now') > /dev/null 2>&1 &
  local pid=$!
  local i
  for ((i = 0; i < 50; i++)); do
    [[ -f "$dir/ready" ]] && break
    sleep 0.1
  done
  if [[ "$sig" != "EXIT" ]]; then
    kill -s "$sig" "$pid" 2> /dev/null
  fi
  wait "$pid" 2> /dev/null
  cat "$dir/no_turbo"
}
check_eq "SIGTERM restores no_turbo" "0" "$(run_restore_case TERM)"
check_eq "SIGINT restores no_turbo" "0" "$(run_restore_case INT)"
check_eq "normal exit restores no_turbo" "0" "$(run_restore_case EXIT)"

echo "== single.sh validation =="
bash "$REPO_ROOT/single.sh" abc > /dev/null 2>&1
check_eq "single.sh rejects non-numeric cpu (rc=2)" "2" "$?"
bash "$REPO_ROOT/single.sh" 0 0 > /dev/null 2>&1
check_eq "single.sh rejects zero runs (rc=2)" "2" "$?"

echo "== capture-fault.sh exit codes =="
bash "$REPO_ROOT/capture-fault.sh" > /dev/null 2>&1
check_eq "capture-fault.sh usage error (rc=2)" "2" "$?"
bash "$REPO_ROOT/capture-fault.sh" 0 x 1 "$TMP/out" > /dev/null 2>&1
check_eq "capture-fault.sh rejects non-numeric runs (rc=2)" "2" "$?"
# Missing dependency: a PATH containing everything except gdb.
mkdir -p "$TMP/bin"
for c in bash grep rm mkdir cat date head tail sort find xargs timeout taskset node tee awk sed chmod tac printf; do
  src="$(command -v "$c" 2> /dev/null || true)"
  [[ -n "$src" && -x "$src" ]] && ln -sf "$src" "$TMP/bin/$c"
done
if command -v gdb > /dev/null 2>&1; then
  PATH="$TMP/bin" bash "$REPO_ROOT/capture-fault.sh" 0 1 1 "$TMP/out" > /dev/null 2>&1
  check_eq "capture-fault.sh missing gdb (rc=4)" "4" "$?"
else
  ok "capture-fault.sh missing gdb (rc=4) [skipped: gdb absent anyway]"
fi

echo "== privileged companion script guards =="
bash "$REPO_ROOT/frequency-ab.sh" > /dev/null 2>&1
check_eq "frequency-ab.sh usage error (rc=2)" "2" "$?"
(cd "$REPO_ROOT" && bash ./frequency-ab.sh 19 1 "$TMP") > /dev/null 2>&1
check_eq "frequency-ab.sh refuses non-root (rc=4)" "4" "$?"
bash "$REPO_ROOT/root-checks.sh" > /dev/null 2>&1
check_eq "root-checks.sh usage error (rc=2)" "2" "$?"
bash "$REPO_ROOT/root-checks.sh" "$TMP" > /dev/null 2>&1
check_eq "root-checks.sh refuses non-root (rc=4)" "4" "$?"

echo "== --redo phase handling =="
RB="$TMP/redo-bundle"
mkdir -p "$RB"/{results,state,logs/individual}
printf '19\t1\t139\t2\n19\t2\t0\t2\n' > "$RB/results/individual.tsv"
touch "$RB/state/phase-individual.done" "$RB/state/phase-baseline.done"
printf 'MODE=quick\nINDIVIDUAL_RUNS=20\nCOMPLETED_PHASES=baseline,individual\n' > "$RB/results/meta.env"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  # Set these after sourcing: diagnose.sh top-level initialises its own.
  OUT_DIR="$RB"
  STATE_DIR="$RB/state"
  META_FILE="$RB/results/meta.env"
  redo_phase individual
) > /dev/null 2>&1
redo_ok=0
[[ ! -f "$RB/results/individual.tsv" ]] &&
  [[ ! -f "$RB/state/phase-individual.done" ]] &&
  compgen -G "$RB/state/superseded/individual-*/individual.tsv" > /dev/null &&
  grep -q '^COMPLETED_PHASES=baseline$' "$RB/results/meta.env" && redo_ok=1
check_eq "--redo individual stashes data, clears marker" "1" "$redo_ok"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  OUT_DIR="$RB"
  STATE_DIR="$RB/state"
  META_FILE="$RB/results/meta.env"
  redo_phase bogus-phase
) > /dev/null 2>&1
[[ $? -ne 0 ]]
check_eq "--redo rejects unknown phase" "0" "$?"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  REDO_PHASES=individual
  RESUME_DIR=""
  validate_config
) > /dev/null 2>&1
[[ $? -ne 0 ]]
check_eq "--redo without --resume is rejected" "0" "$?"

echo "== resumed metadata validation =="
INJECTION_SENTINEL="$TMP/arithmetic-injection-ran"
(
  DIAG_SOURCE_ONLY=1
  source "$REPO_ROOT/diagnose.sh"
  SKIP_GDB='probe[$(touch '"$INJECTION_SENTINEL"')]'
  validate_config
) > /dev/null 2>&1
injection_rc=$?
check_eq "crafted SKIP_GDB metadata is rejected" "1" "$([[ $injection_rc -ne 0 ]] && echo 1 || echo 0)"
check_eq "crafted SKIP_GDB metadata is not evaluated" "0" "$([[ -e "$INJECTION_SENTINEL" ]] && echo 1 || echo 0)"

echo "== node unit tests (stats, parsers) =="
if (cd "$LIB" && node --test 'tests/*.test.mjs') > "$TMP/node-tests.log" 2>&1; then
  ok "node --test stats+parsers"
else
  bad "node --test stats+parsers"
  sed 's/^/    /' "$TMP/node-tests.log" >&2
fi

echo "== end-to-end collect + report on synthetic bundle =="
B="$TMP/bundle"
mkdir -p "$B"/{results,logs/baseline,logs/groups,env,freq,gdb,state}

cat > "$B/results/meta.env" << EOF
MODE=default
START_EPOCH=1753950000
START_ISO=2026-07-31T15:00:00+00:00
END_EPOCH=1753953600
END_ISO=2026-07-31T16:00:00+00:00
BASELINE_CHILDREN=4
BASELINE_WAVES=5
GROUP_WAVES=5
INDIVIDUAL_RUNS=20
GDB_MAX_RUNS=6
FREQUENCY_AB=1
SKIP_GDB=0
COMPLETED_PHASES=preflight,baseline,groups,individual,frequency,gdb
INTERRUPTED=0
EOF

cat > "$B/env/summary.env" << EOF
DISTRO=TestOS
KERNEL=6.0.0-test
NODE_VERSION=v25.2.1
V8_VERSION=14.1.146.11-node.14
CPU_MODEL=Test CPU
ONLINE_CPUS=0-23
TME_STATE=disabled (tme=off on kernel command line)
POWER_SOURCE=battery
NO_TURBO=0
MISSING_OPTIONAL=turbostat
EOF

cp "$FIX/repro-fail.log" "$B/logs/baseline/run1.log"
cat > "$B/results/baseline.meta" << EOF
CHILDREN=4
WAVES=5
LOG=logs/baseline/run1.log
EXIT_CODE=1
EOF

cp "$FIX/repro-fail.log" "$B/logs/groups/ecluster-64.log"
cp "$FIX/repro-clean.log" "$B/logs/groups/pcores.log"
cat > "$B/results/groups.tsv" << EOF
pcores	pcore	0-7	-	4	5	logs/groups/pcores.log	group-pcores	0
ecluster-64	ecluster	16-19	64	4	5	logs/groups/ecluster-64.log	group-ecluster-64	1
EOF

# CPU 8: 20 clean runs; CPU 19: 6 SIGSEGV in 20 runs.
: > "$B/results/individual.tsv"
for i in $(seq 1 20); do
  printf '8\t%s\t0\t2\n' "$i" >> "$B/results/individual.tsv"
done
for i in $(seq 1 20); do
  if ((i <= 6)); then
    printf '19\t%s\t139\t2\n' "$i" >> "$B/results/individual.tsv"
  else
    printf '19\t%s\t0\t2\n' "$i" >> "$B/results/individual.tsv"
  fi
done

cat > "$B/results/frequency-ab.tsv" << EOF
A1	1	139	2
A1	2	0	2
A1	3	139	2
A1	4	0	2
B	1	0	3
B	2	0	3
B	3	0	3
B	4	0	3
A2	1	139	2
A2	2	139	2
A2	3	0	2
A2	4	0	2
EOF
cat > "$B/results/frequency-ab.meta" << EOF
CPU=19
RUNS_PER_LEG=4
SAVED_NO_TURBO=0
LEG_A1_NO_TURBO=0
LEG_A1_SCALING_MAX_KHZ=5500000
LEG_B_NO_TURBO=1
LEG_B_SCALING_MAX_KHZ=5500000
LEG_A2_NO_TURBO=0
LEG_A2_SCALING_MAX_KHZ=5500000
RESTORED=1
EOF
for leg in A1 B A2; do
  printf 'scaling_cur_freq\n' > "$B/freq/freq-ab-${leg}.method"
  if [[ "$leg" == "B" ]]; then mhz=2100000; else mhz=4700000; fi
  printf '1753950000 19 %s\n1753950001 19 %s\n' "$mhz" "$mhz" > "$B/freq/freq-ab-${leg}.samples"
done

cp "$FIX/gdb-known.txt" "$B/gdb/cpu19-run1.txt"
cat > "$B/results/gdb.meta" << EOF
CPU=19
MAX_RUNS=6
EXIT_CODE=0
EOF

# Simulated manual root-checks.sh output.
mkdir -p "$B/env/root"
printf '# cctk read-only allowlist probe\nTurboMode=Enabled\nIntelTME=Disabled\n' > "$B/env/root/cctk.txt"
printf '# intel-undervolt read\ncore (0): voltage offset: 0 mV\n' > "$B/env/root/intel-undervolt.txt"

node "$LIB/collect.mjs" "$B" > /dev/null
node "$LIB/report.mjs" "$B" > /dev/null

# All JSON assertions in one place; prints one line per failure.
cat > "$TMP/check-results.mjs" << 'EOF'
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`ok   ${label}`);
  else { console.log(`FAIL ${label}`); failures += 1; }
};
check("baseline sigsegv count", r.baseline.sigsegvCount === 2);
check("baseline other failures", r.baseline.otherFailureCount === 1);
check("baseline invocations", r.baseline.totalChildInvocations === 20);
check("worst cpu is 19", r.worstCpu === 19);
check("individual tally", r.individual.length === 2 && r.individual[1].sigsegv === 6 && r.individual[0].failures === 0);
check("gdb signature match", r.gdb.captures.length === 1 && r.gdb.captures[0].matchesKnownSignature === true);
check("gdb capture file trimmed", r.gdb.captures[0].mappings === undefined);
check("freq ab restored + legs", r.frequencyAb.restored === true && r.frequencyAb.legs.length === 3);
check("freq leg B measured clock", r.frequencyAb.legs[1].frequency.avgMHz === 2100);
check("group failure tally", r.groups.length === 2 && r.groups[1].sigsegvCount === 2 && r.groups[0].sigsegvCount === 0);
check("root checks merged", Boolean(r.rootChecks) && r.rootChecks["cctk.txt"].includes("IntelTME=Disabled"));
process.exit(failures === 0 ? 0 : 1);
EOF
if node "$TMP/check-results.mjs" "$B/results.json"; then
  pass=$((pass + 11))
else
  fail=$((fail + 1))
fi

grep -q "CPU localization" "$B/report.md"
check_eq "report contains localization conclusion" "0" "$?"
grep -q "documented pattern" "$B/report.md"
check_eq "report contains signature conclusion" "0" "$?"
grep -q "Fisher exact" "$B/report.md"
check_eq "report contains Fisher test" "0" "$?"
grep -q "TME" "$B/report.md"
check_eq "report contains TME rule-out" "0" "$?"
grep -q "battery" "$B/report.md"
check_eq "report contains battery rule-out" "0" "$?"
grep -q "Privileged reads" "$B/report.md"
check_eq "report contains privileged-reads section" "0" "$?"
grep -q "IntelTME=Disabled" "$B/report.md"
check_eq "report includes cctk allowlist data" "0" "$?"

echo
printf 'passed=%d failed=%d\n' "$pass" "$fail"
((fail == 0))
