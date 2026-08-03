#!/usr/bin/env bash
# Restart-safe frequency evidence publication. The caller is unprivileged and
# holds the bundle's directory lock for the lifetime of this transaction.

FREQUENCY_TX_IO_HELPER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/publish-frequency-io.mjs"

frequency_tx_sha256() {
  local path="$1" max_bytes="$2" output size digest extra
  [[ "$max_bytes" =~ ^[1-9][0-9]*$ ]] || return 1
  output="$(node "$FREQUENCY_TX_IO_HELPER" hash "$path" "$max_bytes")" || return 1
  [[ "$output" != *$'\n'* ]] || return 1
  IFS=$'\t' read -r size digest extra <<< "$output"
  [[ "$size" =~ ^(0|[1-9][0-9]*)$ && "$digest" =~ ^[0-9a-f]{64}$ &&
    -z "$extra" ]] || return 1
  ((size <= max_bytes)) || return 1
  printf '%s\n' "$digest"
}

frequency_tx_stable_copy() {
  local source="$1" destination="$2" max_bytes="$3" output size digest extra destination_size
  [[ "$max_bytes" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -f "$source" && ! -L "$source" && ! -e "$destination" && ! -L "$destination" ]] || return 1
  output="$(node "$FREQUENCY_TX_IO_HELPER" copy "$source" "$destination" "$max_bytes")" || return 1
  [[ "$output" != *$'\n'* ]] || return 1
  IFS=$'\t' read -r size digest extra <<< "$output"
  [[ "$size" =~ ^(0|[1-9][0-9]*)$ && "$digest" =~ ^[0-9a-f]{64}$ &&
    -z "$extra" ]] || return 1
  ((size <= max_bytes)) || return 1
  frequency_tx_private_file_is_safe "$destination" || return 1
  destination_size="$(stat -Lc '%s' -- "$destination" 2> /dev/null)" || return 1
  [[ "$destination_size" == "$size" ]]
}

frequency_tx_open_exclusive() {
  local path="$1" output_name="$2" allocated_fd restore_noclobber=0
  if [[ ! -o noclobber ]]; then
    set -C
    restore_noclobber=1
  fi
  if ! exec {allocated_fd}> "$path"; then
    ((restore_noclobber == 0)) || set +C
    return 1
  fi
  ((restore_noclobber == 0)) || set +C
  printf -v "$output_name" '%s' "$allocated_fd"
}

frequency_tx_artifact_limit() {
  case "$1" in
    results/*.meta | freq/*.method) printf '65536\n' ;;
    results/*.tsv) printf '16777216\n' ;;
    freq/*.samples) printf '67108864\n' ;;
    *) return 1 ;;
  esac
}

frequency_tx_command_limit() {
  # Published command history is bounded to keep retries and hashing finite.
  printf '67108864\n'
}

frequency_tx_staged_command_limit() {
  printf '16777216\n'
}

frequency_tx_command_final_limit() {
  printf '67108864\n'
}

frequency_tx_path_state() {
  local path="$1" max_bytes="${2:-67108864}" digest remainder
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    printf 'A\n'
  elif [[ -L "$path" ]]; then
    read -r digest remainder < <(readlink -z -- "$path" | sha256sum) || return 1
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf 'L:%s\n' "$digest"
  elif [[ -f "$path" ]]; then
    digest="$(frequency_tx_sha256 "$path" "$max_bytes")" || return 1
    printf 'F:%s\n' "$digest"
  else
    return 1
  fi
}

frequency_tx_state_is_valid() {
  [[ "$1" == A || "$1" =~ ^[FL]:[0-9a-f]{64}$ ]]
}

frequency_tx_artifact_is_allowed() {
  case "$1" in
    results/frequency-ab.tsv | results/frequency-ab.meta | \
      results/frequency-cap.tsv | results/frequency-cap.meta | \
      freq/freq-ab-A1.samples | freq/freq-ab-A1.method | \
      freq/freq-ab-B.samples | freq/freq-ab-B.method | \
      freq/freq-ab-A2.samples | freq/freq-ab-A2.method | \
      freq/freq-ab-cap.samples | freq/freq-ab-cap.method) return 0 ;;
  esac
  return 1
}

frequency_tx_cap_artifact_is_allowed() {
  case "$1" in
    results/frequency-cap.tsv | results/frequency-cap.meta | \
      freq/freq-ab-cap.samples | freq/freq-ab-cap.method) return 0 ;;
  esac
  return 1
}

frequency_tx_candidate_name() {
  case "$1" in
    results/frequency-ab.tsv) printf 'artifact.frequency-ab.tsv\n' ;;
    results/frequency-ab.meta) printf 'artifact.frequency-ab.meta\n' ;;
    results/frequency-cap.tsv) printf 'artifact.frequency-cap.tsv\n' ;;
    results/frequency-cap.meta) printf 'artifact.frequency-cap.meta\n' ;;
    freq/freq-ab-A1.samples) printf 'artifact.freq-ab-A1.samples\n' ;;
    freq/freq-ab-A1.method) printf 'artifact.freq-ab-A1.method\n' ;;
    freq/freq-ab-B.samples) printf 'artifact.freq-ab-B.samples\n' ;;
    freq/freq-ab-B.method) printf 'artifact.freq-ab-B.method\n' ;;
    freq/freq-ab-A2.samples) printf 'artifact.freq-ab-A2.samples\n' ;;
    freq/freq-ab-A2.method) printf 'artifact.freq-ab-A2.method\n' ;;
    freq/freq-ab-cap.samples) printf 'artifact.freq-ab-cap.samples\n' ;;
    freq/freq-ab-cap.method) printf 'artifact.freq-ab-cap.method\n' ;;
    *) return 1 ;;
  esac
}

frequency_tx_candidate_path() {
  local bundle="$1" rel="$2" name parent
  name="$(frequency_tx_candidate_name "$rel")" || return 1
  parent="${rel%%/*}"
  printf '%s/%s/.%s.frequency-publish.pending\n' "$bundle" "$parent" "$name"
}

frequency_tx_same_device() {
  local candidate="$1" destination="$2" candidate_device parent_device
  candidate_device="$(stat -Lc '%d' -- "$candidate" 2> /dev/null)" || return 1
  parent_device="$(stat -Lc '%d' -- "$(dirname -- "$destination")" 2> /dev/null)" || return 1
  [[ "$candidate_device" =~ ^[0-9]+$ && "$candidate_device" == "$parent_device" ]]
}

frequency_tx_private_file_is_safe() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -Lc '%u:%a:%h' -- "$1" 2> /dev/null)" == "$EUID:600:1" ]]
}

frequency_tx_private_dir_is_safe() {
  [[ -d "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -Lc '%u:%a' -- "$1" 2> /dev/null)" == "$EUID:700" ]]
}

frequency_tx_kill_at() {
  [[ "${DIAG_TEST_FREQUENCY_PUBLISH_KILL_AT:-}" != "$1" ]] || kill -KILL "$BASHPID"
}

frequency_tx_dir_is_empty() {
  local path="$1" first
  first="$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
  [[ -z "$first" ]]
}

frequency_tx_empty_stage_finish() {
  local stage="$1" work="$2" dir parent
  parent="$(dirname -- "$stage")"
  [[ ! -e "$work" && ! -L "$work" ]] || return 1
  if [[ ! -e "$stage/results" && ! -L "$stage/results" &&
    ! -e "$stage/freq" && ! -L "$stage/freq" ]]; then
    frequency_tx_dir_is_empty "$stage" || return 1
    sync -f "$stage" || return 1
    rmdir -- "$stage" || return 1
    sync -f "$parent"
    return
  fi
  for dir in "$stage/results" "$stage/freq"; do
    if [[ -e "$dir" || -L "$dir" ]]; then
      frequency_tx_private_dir_is_safe "$dir" && frequency_tx_dir_is_empty "$dir" || return 1
      sync -f "$dir" || return 1
      rmdir -- "$dir" || return 1
      sync -f "$stage" || return 1
    fi
  done
  frequency_tx_dir_is_empty "$stage" || return 1
  sync -f "$stage" || return 1
  rmdir -- "$stage" || return 1
  sync -f "$parent"
}

frequency_tx_binding_file_matches() {
  local path="$1" transaction="$2" bundle_id="$3" expected actual_sha expected_sha remainder
  expected="$(printf 'TRANSACTION\t%s\nBUNDLE_ID\t%s\n' "$transaction" "$bundle_id")"
  read -r expected_sha remainder < <(
    printf 'TRANSACTION\t%s\nBUNDLE_ID\t%s\n' "$transaction" "$bundle_id" | sha256sum
  ) || return 1
  frequency_tx_private_file_is_safe "$path" || return 1
  [[ "$(stat -Lc '%s' -- "$path" 2> /dev/null)" == "$((${#expected} + 1))" ]] || return 1
  actual_sha="$(frequency_tx_sha256 "$path" 256)" || return 1
  [[ "$actual_sha" == "$expected_sha" ]]
}

frequency_tx_binding_validate() {
  local work="$1" transaction="$2" bundle_id="$3"
  frequency_tx_private_dir_is_safe "$work" || return 1
  frequency_tx_binding_file_matches "$work/transaction.id" "$transaction" "$bundle_id"
}

frequency_tx_binding_prepare() {
  local work="$1" transaction="$2" bundle_id="$3" binding pending
  binding="$work/transaction.id"
  pending="$work/transaction.id.pending"
  if [[ ! -e "$work" && ! -L "$work" ]]; then
    mkdir -m 0700 -- "$work" || return 1
    sync -f "$(dirname -- "$work")" || return 1
  fi
  frequency_tx_private_dir_is_safe "$work" || return 1
  if [[ -e "$binding" || -L "$binding" ]]; then
    frequency_tx_binding_file_matches "$binding" "$transaction" "$bundle_id" || return 1
    [[ ! -e "$pending" && ! -L "$pending" ]] || return 1
    return 0
  fi
  if [[ -e "$pending" || -L "$pending" ]]; then
    frequency_tx_binding_file_matches "$pending" "$transaction" "$bundle_id" || return 1
  else
    (umask 077; printf 'TRANSACTION\t%s\nBUNDLE_ID\t%s\n' \
      "$transaction" "$bundle_id" > "$pending") || return 1
    chmod 0600 "$pending" || return 1
    sync -f "$pending" || return 1
  fi
  frequency_tx_kill_at binding-pending
  mv -fT -- "$pending" "$binding" || return 1
  sync -f "$work"
}

frequency_tx_candidate_prepare() {
  local source="$1" candidate="$2" destination="$3" expected_sha="$4" max_bytes="$5"
  local tmp actual
  tmp="${candidate}.copying"
  frequency_tx_private_file_is_safe "$source" || return 1
  [[ "$(frequency_tx_sha256 "$source" "$max_bytes")" == "$expected_sha" ]] || return 1
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    frequency_tx_private_file_is_safe "$candidate" || return 1
    actual="$(frequency_tx_sha256 "$candidate" "$max_bytes")" || return 1
    if [[ "$actual" == "$expected_sha" ]]; then
      frequency_tx_same_device "$candidate" "$destination"
      return
    fi
    rm -f -- "$candidate" || return 1
  fi
  if [[ -e "$tmp" || -L "$tmp" ]]; then
    frequency_tx_private_file_is_safe "$tmp" || return 1
    rm -f -- "$tmp" || return 1
  fi
  frequency_tx_stable_copy "$source" "$tmp" "$max_bytes" || return 1
  [[ "$(frequency_tx_sha256 "$tmp" "$max_bytes")" == "$expected_sha" ]] || return 1
  frequency_tx_kill_at artifact-copying
  mv -fT -- "$tmp" "$candidate" || return 1
  frequency_tx_same_device "$candidate" "$destination" || return 1
  sync -f "$(dirname -- "$candidate")"
}

frequency_tx_command_scratch_cleanup() {
  local stage="$1" path
  for path in "$stage/.frequency-command-base.snapshot" \
    "$stage/.frequency-command-stage.snapshot" \
    "$stage/.frequency-command-merged.snapshot"; do
    [[ -e "$path" || -L "$path" ]] || continue
    frequency_tx_private_file_is_safe "$path" || return 1
    rm -f -- "$path" || return 1
  done
  sync -f "$stage"
}

frequency_tx_command_merge_snapshots() {
  local base_snapshot="$1" staged_snapshot="$2" merged="$3"
  local command_limit staged_limit final_limit base_size=0 staged_size expected_size
  local base_blocks staged_blocks output_fd output_size
  command_limit="$(frequency_tx_command_limit)"
  staged_limit="$(frequency_tx_staged_command_limit)"
  final_limit="$(frequency_tx_command_final_limit)"
  [[ ! -e "$merged" && ! -L "$merged" ]] || return 1
  staged_size="$(stat -Lc '%s' -- "$staged_snapshot" 2> /dev/null)" || return 1
  [[ "$staged_size" =~ ^[0-9]+$ ]] && ((staged_size <= staged_limit)) || return 1
  if [[ -n "$base_snapshot" ]]; then
    base_size="$(stat -Lc '%s' -- "$base_snapshot" 2> /dev/null)" || return 1
    [[ "$base_size" =~ ^[0-9]+$ ]] && ((base_size <= command_limit)) || return 1
  fi
  base_blocks=$((command_limit / 65536 + 1))
  staged_blocks=$((staged_limit / 65536 + 1))
  frequency_tx_open_exclusive "$merged" output_fd || return 1
  if ! {
    if [[ -n "$base_snapshot" ]]; then
      dd if="$base_snapshot" iflag=nofollow,nonblock bs=65536 count="$base_blocks" status=none || exit 1
      if ((base_size > 0 && staged_size > 0)); then printf '\n'; fi
    fi
    dd if="$staged_snapshot" iflag=nofollow,nonblock bs=65536 count="$staged_blocks" status=none || exit 1
  } | dd of="/proc/self/fd/$output_fd" conv=notrunc bs=65536 status=none; then
    exec {output_fd}>&-
    return 1
  fi
  chmod 0600 "/proc/self/fd/$output_fd" || { exec {output_fd}>&-; return 1; }
  sync -f "/proc/self/fd/$output_fd" || { exec {output_fd}>&-; return 1; }
  exec {output_fd}>&-
  expected_size=$((base_size + staged_size))
  ((base_size == 0 || staged_size == 0)) || ((expected_size += 1))
  output_size="$(stat -Lc '%s' -- "$merged" 2> /dev/null)" || return 1
  [[ "$output_size" =~ ^[0-9]+$ && "$output_size" == "$expected_size" ]] || return 1
  ((output_size <= final_limit)) || return 1
  sync -f "$merged"
}

frequency_tx_command_plan() {
  local stage="$1" destination="$2" staged="$3"
  local base_snapshot="$stage/.frequency-command-base.snapshot"
  local staged_snapshot="$stage/.frequency-command-stage.snapshot"
  local merged="$stage/.frequency-command-merged.snapshot"
  local command_limit staged_limit final_limit staged_sha base_state base_sha final_sha
  command_limit="$(frequency_tx_command_limit)"
  staged_limit="$(frequency_tx_staged_command_limit)"
  final_limit="$(frequency_tx_command_final_limit)"
  frequency_tx_command_scratch_cleanup "$stage" || return 1
  frequency_tx_stable_copy "$staged" "$staged_snapshot" "$staged_limit" || return 1
  staged_sha="$(frequency_tx_sha256 "$staged_snapshot" "$staged_limit")" || return 1
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    base_state=A
    base_snapshot=""
  elif [[ -f "$destination" && ! -L "$destination" ]]; then
    frequency_tx_stable_copy "$destination" "$base_snapshot" "$command_limit" || return 1
    base_sha="$(frequency_tx_sha256 "$base_snapshot" "$command_limit")" || return 1
    base_state="F:$base_sha"
  else
    return 1
  fi
  frequency_tx_command_merge_snapshots "$base_snapshot" "$staged_snapshot" "$merged" || return 1
  final_sha="$(frequency_tx_sha256 "$merged" "$final_limit")" || return 1
  [[ "$(frequency_tx_sha256 "$staged" "$staged_limit")" == "$staged_sha" ]] || return 1
  [[ "$(frequency_tx_path_state "$destination" "$command_limit")" == "$base_state" ]] || return 1
  frequency_tx_command_scratch_cleanup "$stage" || return 1
  printf '%s\t%s\t%s\n' "$staged_sha" "$base_state" "$final_sha"
}

frequency_tx_command_candidate_prepare() {
  local stage="$1" destination="$2" staged="$3" candidate="$4" staged_sha="$5"
  local base_state="$6" final_sha="$7" tmp="${4}.copying"
  local base_snapshot="$stage/.frequency-command-base.snapshot"
  local staged_snapshot="$stage/.frequency-command-stage.snapshot"
  local merged="$stage/.frequency-command-merged.snapshot"
  local command_limit staged_limit final_limit current actual base_sha
  command_limit="$(frequency_tx_command_limit)"
  staged_limit="$(frequency_tx_staged_command_limit)"
  final_limit="$(frequency_tx_command_final_limit)"
  frequency_tx_private_file_is_safe "$staged" || return 1
  frequency_tx_command_scratch_cleanup "$stage" || return 1
  frequency_tx_stable_copy "$staged" "$staged_snapshot" "$staged_limit" || return 1
  [[ "$(frequency_tx_sha256 "$staged_snapshot" "$staged_limit")" == "$staged_sha" ]] || return 1
  current="$(frequency_tx_path_state "$destination" "$command_limit")" || return 1
  [[ "$current" == "$base_state" ]] || return 1
  if [[ "$base_state" == F:* ]]; then
    frequency_tx_stable_copy "$destination" "$base_snapshot" "$command_limit" || return 1
    base_sha="$(frequency_tx_sha256 "$base_snapshot" "$command_limit")" || return 1
    [[ "$base_state" == "F:$base_sha" ]] || return 1
  else
    base_snapshot=""
  fi
  frequency_tx_command_merge_snapshots "$base_snapshot" "$staged_snapshot" "$merged" || return 1
  [[ "$(frequency_tx_sha256 "$merged" "$final_limit")" == "$final_sha" ]] || return 1
  [[ "$(frequency_tx_sha256 "$staged" "$staged_limit")" == "$staged_sha" ]] || return 1
  [[ "$(frequency_tx_path_state "$destination" "$command_limit")" == "$base_state" ]] || return 1
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    frequency_tx_private_file_is_safe "$candidate" || return 1
    actual="$(frequency_tx_sha256 "$candidate" "$final_limit")" || return 1
    if [[ "$actual" == "$final_sha" ]]; then
      frequency_tx_command_scratch_cleanup "$stage" || return 1
      frequency_tx_same_device "$candidate" "$destination"
      return
    fi
    rm -f -- "$candidate" || return 1
  fi
  if [[ -e "$tmp" || -L "$tmp" ]]; then
    frequency_tx_private_file_is_safe "$tmp" || return 1
    rm -f -- "$tmp" || return 1
  fi
  frequency_tx_stable_copy "$merged" "$tmp" "$final_limit" || return 1
  [[ "$(frequency_tx_sha256 "$tmp" "$final_limit")" == "$final_sha" ]] || return 1
  frequency_tx_command_scratch_cleanup "$stage" || return 1
  frequency_tx_kill_at commands-copying
  mv -fT -- "$tmp" "$candidate" || return 1
  frequency_tx_same_device "$candidate" "$destination" || return 1
  sync -f "$(dirname -- "$candidate")"
}

frequency_tx_work_inventory_is_safe() (
  local work="$1" path unknown
  [[ ! -e "$work" && ! -L "$work" ]] && return 0
  frequency_tx_private_dir_is_safe "$work" || return 1
  unknown="$(find "$work" -mindepth 1 -maxdepth 1 \
    ! -name transaction.id ! -name transaction.id.pending -print -quit)" || return 1
  [[ -z "$unknown" ]] || return 1
  for path in "$work/transaction.id" "$work/transaction.id.pending"; do
    [[ -e "$path" || -L "$path" ]] || continue
    frequency_tx_private_file_is_safe "$path" || return 1
  done
)

frequency_tx_stage_inventory_is_safe() (
  local stage="$1" journal_present="$2" path rel unknown
  local -n known_ref="$3"
  for path in "$stage/results" "$stage/freq"; do
    frequency_tx_private_dir_is_safe "$path" || return 1
  done
  unknown="$(find "$stage" -mindepth 1 -maxdepth 1 \
    ! -name results ! -name freq ! -name commands.log \
    ! -name publish-control.meta ! -name publish-journal.pending \
    ! -name publish-journal.tsv -print -quit)" || return 1
  [[ -z "$unknown" ]] || return 1
  for path in "$stage/commands.log" "$stage/publish-control.meta" \
    "$stage/publish-journal.pending"; do
    [[ -e "$path" || -L "$path" ]] || continue
    frequency_tx_private_file_is_safe "$path" || return 1
  done
  path="$stage/publish-journal.tsv"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ "$journal_present" == 1 ]] && frequency_tx_private_file_is_safe "$path" || return 1
  fi
  unknown="$(find "$stage/results" -mindepth 1 -maxdepth 1 \
    ! -name frequency-ab.tsv ! -name frequency-ab.meta \
    ! -name frequency-cap.tsv ! -name frequency-cap.meta -print -quit)" || return 1
  [[ -z "$unknown" ]] || return 1
  unknown="$(find "$stage/freq" -mindepth 1 -maxdepth 1 \
    ! -name freq-ab-A1.samples ! -name freq-ab-A1.method \
    ! -name freq-ab-B.samples ! -name freq-ab-B.method \
    ! -name freq-ab-A2.samples ! -name freq-ab-A2.method \
    ! -name freq-ab-cap.samples ! -name freq-ab-cap.method -print -quit)" || return 1
  [[ -z "$unknown" ]] || return 1
  local -a fixed_rels=(
    results/frequency-ab.tsv results/frequency-ab.meta
    results/frequency-cap.tsv results/frequency-cap.meta
    freq/freq-ab-A1.samples freq/freq-ab-A1.method
    freq/freq-ab-B.samples freq/freq-ab-B.method
    freq/freq-ab-A2.samples freq/freq-ab-A2.method
    freq/freq-ab-cap.samples freq/freq-ab-cap.method
  )
  for rel in "${fixed_rels[@]}"; do
    path="$stage/$rel"
    [[ -e "$path" || -L "$path" ]] || continue
    [[ -n "${known_ref[$rel]:-}" || "$journal_present" == 0 ]] || return 1
    frequency_tx_private_file_is_safe "$path" || return 1
  done
)

frequency_tx_candidate_inventory_is_safe() {
  local bundle="$1" command_candidate="$2" rel destination candidate path
  local -n rels_ref="$3"
  for path in "$command_candidate" "${command_candidate}.copying"; do
    [[ -e "$path" || -L "$path" ]] || continue
    frequency_tx_private_file_is_safe "$path" || return 1
    frequency_tx_same_device "$path" "$bundle/commands.log" || return 1
  done
  for rel in "${rels_ref[@]}"; do
    destination="$bundle/$rel"
    candidate="$(frequency_tx_candidate_path "$bundle" "$rel")" || return 1
    for path in "$candidate" "${candidate}.copying"; do
      [[ -e "$path" || -L "$path" ]] || continue
      frequency_tx_private_file_is_safe "$path" || return 1
      frequency_tx_same_device "$path" "$destination" || return 1
    done
  done
}

frequency_tx_candidates_absent() {
  local bundle="$1" command_candidate="$2" rel candidate
  local -n rels_ref="$3"
  [[ ! -e "$command_candidate" && ! -L "$command_candidate" &&
    ! -e "${command_candidate}.copying" && ! -L "${command_candidate}.copying" ]] || return 1
  for rel in "${rels_ref[@]}"; do
    candidate="$(frequency_tx_candidate_path "$bundle" "$rel")" || return 1
    [[ ! -e "$candidate" && ! -L "$candidate" &&
      ! -e "${candidate}.copying" && ! -L "${candidate}.copying" ]] || return 1
  done
}

frequency_tx_fence_preflight() {
  local work="$1" transaction="$2" bundle_id="$3" bundle="$4" command_candidate="$5"
  local -n all_rels_ref="$6"
  local binding="$work/transaction.id" pending="$work/transaction.id.pending"
  if [[ ! -e "$work" && ! -L "$work" ]]; then
    frequency_tx_candidates_absent "$bundle" "$command_candidate" all_rels_ref
    return
  fi
  frequency_tx_work_inventory_is_safe "$work" || return 1
  if [[ -e "$binding" || -L "$binding" ]]; then
    frequency_tx_binding_validate "$work" "$transaction" "$bundle_id" || return 1
    [[ ! -e "$pending" && ! -L "$pending" ]] || return 1
    frequency_tx_candidate_inventory_is_safe "$bundle" "$command_candidate" all_rels_ref
    return
  fi
  frequency_tx_candidates_absent "$bundle" "$command_candidate" all_rels_ref || return 1
  [[ -e "$pending" || -L "$pending" ]] || return 0
  frequency_tx_binding_file_matches "$pending" "$transaction" "$bundle_id"
}

frequency_tx_journal_write() {
  local journal="$1" tmp="$2" state="$3" transaction="$4" bundle_id="$5"
  local cap_cleanup="$6" command_stage_sha="$7" command_base="$8" command_final_sha="$9"
  local -n rels_ref="${10}" shas_ref="${11}" bases_ref="${12}"
  local -n delete_rels_ref="${13}" delete_bases_ref="${14}"
  local index
  if [[ -e "$tmp" || -L "$tmp" ]]; then
    frequency_tx_private_file_is_safe "$tmp" || return 1
    rm -f -- "$tmp" || return 1
  fi
  {
    printf 'VERSION\t1\nSTATE\t%s\nTRANSACTION\t%s\nBUNDLE_ID\t%s\n' \
      "$state" "$transaction" "$bundle_id"
    printf 'CAP_CLEANUP\t%s\n' "$cap_cleanup"
    printf 'COMMAND\t%s\t%s\t%s\n' "$command_stage_sha" "$command_base" "$command_final_sha"
    for index in "${!rels_ref[@]}"; do
      printf 'ARTIFACT\t%s\t%s\t%s\n' "${rels_ref[$index]}" \
        "${shas_ref[$index]}" "${bases_ref[$index]}"
    done
    for index in "${!delete_rels_ref[@]}"; do
      printf 'DELETE\t%s\t%s\n' "${delete_rels_ref[$index]}" "${delete_bases_ref[$index]}"
    done
  } > "$tmp" || return 1
  chmod 0600 "$tmp" || return 1
  sync -f "$tmp" || return 1
  frequency_tx_kill_at "journal-${state,,}-pending"
  mv -fT -- "$tmp" "$journal" || return 1
  sync -f "$(dirname -- "$journal")"
}

frequency_tx_cleanup_committed() {
  local stage="$1" bundle="$2" work="$3" journal="$4" journal_tmp="$5"
  local control="$6" staged_commands="$7"
  local transaction="$8" bundle_id="$9" command_candidate="${10}"
  local -n artifact_rels_ref="${11}" all_artifacts_ref="${12}"
  local rel path candidate destination dir unknown parent cleaned=0 removed_dirs=0 binding_owned=0
  parent="$(dirname -- "$stage")"

  # A COMMITTED journal authorizes cleanup only for its own exact bundle fence.
  # Validate that binding before removing stage sources or any shared candidate.
  if [[ -e "$work" || -L "$work" ]]; then
    frequency_tx_work_inventory_is_safe "$work" || return 1
    if [[ -e "$work/transaction.id" || -L "$work/transaction.id" ]]; then
      frequency_tx_binding_validate "$work" "$transaction" "$bundle_id" || return 1
      frequency_tx_candidate_inventory_is_safe "$bundle" "$command_candidate" all_artifacts_ref || return 1
      binding_owned=1
    else
      [[ ! -e "$work/transaction.id.pending" && ! -L "$work/transaction.id.pending" ]] || return 1
      frequency_tx_dir_is_empty "$work" || return 1
      frequency_tx_candidates_absent "$bundle" "$command_candidate" all_artifacts_ref || return 1
    fi
  else
    frequency_tx_candidates_absent "$bundle" "$command_candidate" all_artifacts_ref || return 1
  fi

  for rel in "${artifact_rels_ref[@]}"; do
    path="$stage/$rel"
    [[ -e "$path" || -L "$path" ]] || continue
    frequency_tx_private_file_is_safe "$path" || return 1
    rm -f -- "$path" || return 1
    ((cleaned += 1))
    ((cleaned != 1)) || frequency_tx_kill_at first-source-cleaned
  done
  for dir in "$stage/results" "$stage/freq"; do
    [[ ! -e "$dir" && ! -L "$dir" ]] || sync -f "$dir" || return 1
  done
  for path in "$staged_commands" "$control"; do
    [[ -e "$path" || -L "$path" ]] || continue
    frequency_tx_private_file_is_safe "$path" || return 1
    rm -f -- "$path" || return 1
    if [[ "$path" == "$staged_commands" ]]; then
      ((cleaned += 1))
      ((cleaned != 1)) || frequency_tx_kill_at first-source-cleaned
    fi
  done
  frequency_tx_command_scratch_cleanup "$stage" || return 1
  sync -f "$stage" || return 1

  if [[ -e "$work" || -L "$work" ]]; then
    if ((binding_owned == 1)); then
      for path in "$command_candidate" "${command_candidate}.copying"; do
        [[ -e "$path" || -L "$path" ]] || continue
        frequency_tx_private_file_is_safe "$path" || return 1
        rm -f -- "$path" || return 1
      done
      for rel in "${all_artifacts_ref[@]}"; do
        candidate="$(frequency_tx_candidate_path "$bundle" "$rel")" || return 1
        for path in "$candidate" "${candidate}.copying"; do
          [[ -e "$path" || -L "$path" ]] || continue
          frequency_tx_private_file_is_safe "$path" || return 1
          rm -f -- "$path" || return 1
        done
      done
      sync -f "$bundle/results" || return 1
      sync -f "$bundle/freq" || return 1
      sync -f "$bundle" || return 1
      if [[ -e "$work/transaction.id.pending" || -L "$work/transaction.id.pending" ]]; then
        frequency_tx_binding_file_matches "$work/transaction.id.pending" \
          "$transaction" "$bundle_id" || return 1
        rm -f -- "$work/transaction.id.pending" || return 1
        sync -f "$work" || return 1
      fi
      frequency_tx_binding_file_matches "$work/transaction.id" "$transaction" "$bundle_id" || return 1
      rm -f -- "$work/transaction.id" || return 1
      sync -f "$work" || return 1
      frequency_tx_kill_at binding-removed
    fi
    rmdir -- "$work" || return 1
    sync -f "$bundle" || return 1
  fi

  for dir in "$stage/results" "$stage/freq"; do
    if [[ -e "$dir" || -L "$dir" ]]; then
      frequency_tx_private_dir_is_safe "$dir" && frequency_tx_dir_is_empty "$dir" || return 1
      sync -f "$dir" || return 1
      rmdir -- "$dir" || return 1
      sync -f "$stage" || return 1
      ((removed_dirs += 1))
      ((removed_dirs != 1)) || frequency_tx_kill_at first-stage-dir-removed
    fi
  done
  if [[ -e "$journal_tmp" || -L "$journal_tmp" ]]; then
    frequency_tx_private_file_is_safe "$journal_tmp" || return 1
    rm -f -- "$journal_tmp" || return 1
    sync -f "$stage" || return 1
  fi
  frequency_tx_private_file_is_safe "$journal" || return 1
  unknown="$(find "$stage" -mindepth 1 -maxdepth 1 ! -name publish-journal.tsv -print -quit)" || return 1
  [[ -z "$unknown" ]] || return 1
  sync -f "$stage" || return 1
  rm -f -- "$journal" || return 1
  sync -f "$stage" || return 1
  frequency_tx_kill_at journal-removed
  frequency_tx_dir_is_empty "$stage" || return 1
  sync -f "$stage" || return 1
  rmdir -- "$stage" || return 1
  sync -f "$parent"
}

publish_frequency_transaction() {
  local stage="$1" bundle="$2"
  local work journal journal_tmp control
  local staged_commands commands_destination command_candidate
  work="$bundle/.frequency-publish.pending"
  journal="$stage/publish-journal.tsv"
  journal_tmp="$stage/publish-journal.pending"
  control="$stage/publish-control.meta"
  staged_commands="$stage/commands.log"
  commands_destination="$bundle/commands.log"
  command_candidate="$bundle/.commands.log.frequency-publish.pending"
  local transaction="" cap_cleanup=0 control_generation="" control_cap=""
  local journal_state="" bundle_id=""
  local commands_stage_sha="" commands_base="" commands_final_sha=""
  local journal_present=0 control_present=0 commands_present=0
  local path rel state sha candidate current limit command_limit staged_command_limit final_command_limit plan extra_field
  local -a journal_lines=() journal_record_lines=()
  local -a artifact_rels=() artifact_shas=() artifact_bases=()
  local -a delete_rels=() delete_bases=()
  local -A journal_artifacts=() journal_deletes=() stage_seen=()
  local -a all_artifacts=(
    results/frequency-ab.tsv results/frequency-ab.meta
    results/frequency-cap.tsv results/frequency-cap.meta
    freq/freq-ab-A1.samples freq/freq-ab-A1.method
    freq/freq-ab-B.samples freq/freq-ab-B.method
    freq/freq-ab-A2.samples freq/freq-ab-A2.method
    freq/freq-ab-cap.samples freq/freq-ab-cap.method
  )
  local -a cap_artifacts=(
    results/frequency-cap.tsv results/frequency-cap.meta
    freq/freq-ab-cap.samples freq/freq-ab-cap.method
  )
  command_limit="$(frequency_tx_command_limit)"
  staged_command_limit="$(frequency_tx_staged_command_limit)"
  final_command_limit="$(frequency_tx_command_final_limit)"
  bundle_id="$(stat -Lc '%d:%i' -- "$bundle" 2> /dev/null)" || return 1
  [[ "$bundle_id" =~ ^[0-9]+:[0-9]+$ ]] || return 1

  [[ -e "$journal" || -L "$journal" ]] && journal_present=1
  [[ -e "$control" || -L "$control" ]] && control_present=1
  [[ -e "$staged_commands" || -L "$staged_commands" ]] && commands_present=1
  local stage_error_rc=76
  if ((journal_present == 1)) || [[ -e "$work" || -L "$work" ]]; then
    stage_error_rc=1
  fi

  frequency_tx_private_dir_is_safe "$stage" || {
    echo "error: frequency staging directory has unsafe ownership or mode" >&2
    return "$stage_error_rc"
  }
  [[ -d "$bundle" && ! -L "$bundle" && -w "$bundle" && -x "$bundle" ]] || {
    echo "error: diagnostics bundle changed after its writer lock was acquired" >&2
    return 1
  }
  frequency_tx_command_scratch_cleanup "$stage" || return "$stage_error_rc"

  if ((journal_present == 0 && control_present == 0 && commands_present == 0)); then
    frequency_tx_empty_stage_finish "$stage" "$work" || {
      echo "error: empty frequency stage is not a verified post-commit cleanup" >&2
      return "$stage_error_rc"
    }
    return 0
  fi

  if ((control_present == 1)); then
    frequency_tx_private_file_is_safe "$control" || {
      echo "error: unsafe frequency publication control" >&2
      return "$stage_error_rc"
    }
    local control_record control_kind control_size control_actual_sha extra
    control_record="$(node "$FREQUENCY_TX_IO_HELPER" control "$control")" || return "$stage_error_rc"
    [[ "$control_record" != *$'\n'* ]] || return "$stage_error_rc"
    IFS=$'\t' read -r control_kind control_size control_actual_sha \
      control_generation control_cap extra <<< "$control_record"
    [[ "$control_kind" == CONTROL && "$control_size" == 70 &&
      "$control_actual_sha" =~ ^[0-9a-f]{64}$ &&
      "$control_generation" =~ ^[0-9a-f]{32}$ &&
      ( "$control_cap" == 0 || "$control_cap" == 1 ) && -z "$extra" ]] || {
      echo "error: malformed frequency publication control" >&2
      return "$stage_error_rc"
    }
    local control_expected_sha remainder
    read -r control_expected_sha remainder < <(
      printf 'VERSION=1\nGENERATION=%s\nCAP_REQUESTED=%s\n' \
        "$control_generation" "$control_cap" | sha256sum
    ) || return 1
    [[ "$control_expected_sha" =~ ^[0-9a-f]{64}$ &&
      "$control_actual_sha" == "$control_expected_sha" ]] || {
      echo "error: frequency publication control is not canonical byte-for-byte" >&2
      return "$stage_error_rc"
    }
    transaction="$control_generation"
    cap_cleanup=$((control_cap == 0 ? 1 : 0))
  fi

  if ((journal_present == 1)); then
    frequency_tx_private_file_is_safe "$journal" || {
      echo "error: unsafe frequency publication journal" >&2
      return 1
    }
    local journal_size journal_expected_sha journal_actual_sha journal_record journal_kind header_extra
    journal_record="$(node "$FREQUENCY_TX_IO_HELPER" journal "$journal")" || return 1
    mapfile -t journal_record_lines <<< "$journal_record" || return 1
    ((${#journal_record_lines[@]} >= 7)) || return 1
    IFS=$'\t' read -r journal_kind journal_size journal_actual_sha header_extra \
      <<< "${journal_record_lines[0]}"
    [[ "$journal_kind" == JOURNAL && "$journal_actual_sha" =~ ^[0-9a-f]{64}$ &&
      -z "$header_extra" ]] || return 1
    journal_lines=("${journal_record_lines[@]:1}")
    [[ "$journal_size" =~ ^[0-9]+$ ]] && ((journal_size > 0 && journal_size <= 16384)) || return 1
    ((${#journal_lines[@]} >= 6 && ${#journal_lines[@]} <= 32)) &&
      [[ "${journal_lines[0]}" == $'VERSION\t1' ]] || {
      echo "error: malformed frequency publication journal" >&2
      return 1
    }
    local kind a b c extra index
    IFS=$'\t' read -r kind a extra <<< "${journal_lines[1]}"
    [[ "$kind" == STATE && ( "$a" == PREPARED || "$a" == COMMITTED ) && -z "$extra" ]] || return 1
    journal_state="$a"
    IFS=$'\t' read -r kind a extra <<< "${journal_lines[2]}"
    [[ "$kind" == TRANSACTION && "$a" =~ ^([0-9a-f]{32}|legacy-[0-9a-f]{64})$ && -z "$extra" ]] || return 1
    [[ -z "$transaction" || "$transaction" == "$a" ]] || return 1
    transaction="$a"
    IFS=$'\t' read -r kind a extra <<< "${journal_lines[3]}"
    [[ "$kind" == BUNDLE_ID && "$a" == "$bundle_id" && -z "$extra" ]] || return 1
    IFS=$'\t' read -r kind a extra <<< "${journal_lines[4]}"
    [[ "$kind" == CAP_CLEANUP && ( "$a" == 0 || "$a" == 1 ) && -z "$extra" ]] || return 1
    cap_cleanup="$a"
    [[ -z "$control_cap" || "$cap_cleanup" == $((control_cap == 0 ? 1 : 0)) ]] || return 1
    IFS=$'\t' read -r kind a b c extra <<< "${journal_lines[5]}"
    [[ "$kind" == COMMAND && "$a" =~ ^[0-9a-f]{64}$ &&
      ( "$b" == A || "$b" =~ ^F:[0-9a-f]{64}$ ) &&
      "$c" =~ ^[0-9a-f]{64}$ && -z "$extra" ]] || return 1
    commands_stage_sha="$a"
    commands_base="$b"
    commands_final_sha="$c"
    for ((index = 6; index < ${#journal_lines[@]}; index++)); do
      IFS=$'\t' read -r kind a b c extra <<< "${journal_lines[$index]}"
      case "$kind" in
        ARTIFACT)
          frequency_tx_artifact_is_allowed "$a" && [[ "$b" =~ ^[0-9a-f]{64}$ ]] &&
            frequency_tx_state_is_valid "$c" && [[ -z "$extra" && -z "${journal_artifacts[$a]:-}" &&
            -z "${journal_deletes[$a]:-}" ]] || return 1
          artifact_rels+=("$a")
          artifact_shas+=("$b")
          artifact_bases+=("$c")
          journal_artifacts["$a"]=1
          ;;
        DELETE)
          frequency_tx_cap_artifact_is_allowed "$a" && frequency_tx_state_is_valid "$b" &&
            [[ -z "$c" && -z "$extra" && -z "${journal_artifacts[$a]:-}" &&
            -z "${journal_deletes[$a]:-}" ]] || return 1
          delete_rels+=("$a")
          delete_bases+=("$b")
          journal_deletes["$a"]=1
          ;;
        *) return 1 ;;
      esac
    done
    if ((cap_cleanup == 1)); then
      ((${#delete_rels[@]} == ${#cap_artifacts[@]})) || return 1
      for rel in "${cap_artifacts[@]}"; do [[ -n "${journal_deletes[$rel]:-}" ]] || return 1; done
    else
      ((${#delete_rels[@]} == 0)) || return 1
    fi
    read -r journal_expected_sha remainder < <(
      {
        printf 'VERSION\t1\nSTATE\t%s\nTRANSACTION\t%s\nBUNDLE_ID\t%s\n' \
          "$journal_state" "$transaction" "$bundle_id"
        printf 'CAP_CLEANUP\t%s\n' "$cap_cleanup"
        printf 'COMMAND\t%s\t%s\t%s\n' "$commands_stage_sha" "$commands_base" "$commands_final_sha"
        for index in "${!artifact_rels[@]}"; do
          printf 'ARTIFACT\t%s\t%s\t%s\n' "${artifact_rels[$index]}" \
            "${artifact_shas[$index]}" "${artifact_bases[$index]}"
        done
        for index in "${!delete_rels[@]}"; do
          printf 'DELETE\t%s\t%s\n' "${delete_rels[$index]}" "${delete_bases[$index]}"
        done
      } | sha256sum
    ) || return 1
    [[ "$journal_expected_sha" == "$journal_actual_sha" ]] || return 1
  else
    if ((commands_present == 0)); then
      echo "error: unjournaled frequency stage has no command source" >&2
      return "$stage_error_rc"
    fi
    frequency_tx_private_file_is_safe "$staged_commands" || return "$stage_error_rc"
    [[ "$(stat -Lc '%s' -- "$staged_commands" 2> /dev/null)" =~ ^[0-9]+$ ]] &&
      ((BASH_REMATCH[0] <= staged_command_limit)) || return "$stage_error_rc"
    frequency_tx_command_scratch_cleanup "$stage" || return "$stage_error_rc"
    frequency_tx_stage_inventory_is_safe "$stage" 0 stage_seen || return "$stage_error_rc"
    if ((cap_cleanup == 1)); then
      for rel in "${cap_artifacts[@]}"; do
        [[ ! -e "$stage/$rel" && ! -L "$stage/$rel" ]] || return "$stage_error_rc"
      done
    fi
    plan="$(frequency_tx_command_plan "$stage" "$commands_destination" "$staged_commands")" || return 1
    IFS=$'\t' read -r commands_stage_sha commands_base commands_final_sha extra_field <<< "$plan"
    [[ "$commands_stage_sha" =~ ^[0-9a-f]{64}$ &&
      ( "$commands_base" == A || "$commands_base" =~ ^F:[0-9a-f]{64}$ ) &&
      "$commands_final_sha" =~ ^[0-9a-f]{64}$ && -z "$extra_field" ]] || return 1
    [[ -n "$transaction" ]] || transaction="legacy-$commands_stage_sha"
  fi

  if [[ "$journal_state" == COMMITTED ]]; then
    frequency_tx_cleanup_committed "$stage" "$bundle" "$work" "$journal" "$journal_tmp" \
      "$control" "$staged_commands" "$transaction" "$bundle_id" "$command_candidate" \
      artifact_rels all_artifacts
    return
  fi

  if ((journal_present == 0)); then
    for rel in "${all_artifacts[@]}"; do
      path="$stage/$rel"
      [[ -e "$path" || -L "$path" ]] || continue
      frequency_tx_private_file_is_safe "$path" || return "$stage_error_rc"
      limit="$(frequency_tx_artifact_limit "$rel")" || return 1
      [[ "$(stat -Lc '%s' -- "$path" 2> /dev/null)" =~ ^[0-9]+$ ]] &&
        ((BASH_REMATCH[0] <= limit)) || return "$stage_error_rc"
      sha="$(frequency_tx_sha256 "$path" "$limit")" || return 1
      state="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
      artifact_rels+=("$rel")
      artifact_shas+=("$sha")
      artifact_bases+=("$state")
      journal_artifacts["$rel"]=1
    done
    if ((cap_cleanup == 1)); then
      for rel in "${cap_artifacts[@]}"; do
        [[ -z "${journal_artifacts[$rel]:-}" ]] || return 1
        limit="$(frequency_tx_artifact_limit "$rel")" || return 1
        state="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
        delete_rels+=("$rel")
        delete_bases+=("$state")
        journal_deletes["$rel"]=1
      done
    fi
  fi

  frequency_tx_stage_inventory_is_safe "$stage" "$journal_present" journal_artifacts || return 1
  frequency_tx_fence_preflight "$work" "$transaction" "$bundle_id" "$bundle" \
    "$command_candidate" all_artifacts || return 1

  # Complete the read-only transaction preflight before the first bundle
  # mutation. A retry may observe only the recorded base or the desired new
  # value; any third value is an interleaving/tamper failure.
  for index in "${!artifact_rels[@]}"; do
    rel="${artifact_rels[$index]}"
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    current="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
    [[ "$current" == "${artifact_bases[$index]}" ||
      "$current" == "F:${artifact_shas[$index]}" ]] || {
      echo "error: frequency destination changed outside its journal: $rel" >&2
      return 1
    }
    path="$stage/$rel"
    if [[ -e "$path" || -L "$path" ]]; then
      frequency_tx_private_file_is_safe "$path" &&
        [[ "$(frequency_tx_sha256 "$path" "$limit")" == "${artifact_shas[$index]}" ]] || return 1
    elif [[ "$current" != "F:${artifact_shas[$index]}" ]]; then
      echo "error: journaled frequency source is missing before commit: $rel" >&2
      return 1
    fi
  done
  for index in "${!delete_rels[@]}"; do
    rel="${delete_rels[$index]}"
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    current="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
    [[ "$current" == "${delete_bases[$index]}" || "$current" == A ]] || {
      echo "error: stale cap destination changed outside its journal: $rel" >&2
      return 1
    }
  done
  current="$(frequency_tx_path_state "$commands_destination" "$command_limit")" || return 1
  [[ "$current" == "$commands_base" || "$current" == "F:$commands_final_sha" ]] || {
    echo "error: bundle command log changed outside the frequency publication journal" >&2
    return 1
  }
  if ((commands_present == 1)); then
    frequency_tx_private_file_is_safe "$staged_commands" &&
      [[ "$(frequency_tx_sha256 "$staged_commands" "$staged_command_limit")" == "$commands_stage_sha" ]] || return 1
  elif [[ "$current" != "F:$commands_final_sha" ]]; then
    echo "error: journaled frequency command source is missing before commit" >&2
    return 1
  fi
  local dir target_dir
  for dir in results freq state; do
    target_dir="$bundle/$dir"
    if [[ -e "$target_dir" || -L "$target_dir" ]]; then
      [[ -d "$target_dir" && ! -L "$target_dir" && -w "$target_dir" && -x "$target_dir" ]] || return 1
    fi
  done
  local completion_marker="$bundle/state/phase-frequency.done"
  [[ (! -e "$completion_marker" && ! -L "$completion_marker") ||
    -f "$completion_marker" || -L "$completion_marker" ]] || return 1

  publish_invalidate_derived_outputs "$bundle" || return 1
  frequency_tx_kill_at derived-invalidated
  for dir in results freq state; do
    target_dir="$bundle/$dir"
    if [[ ! -e "$target_dir" && ! -L "$target_dir" ]]; then
      mkdir -- "$target_dir" || return 1
    fi
    [[ -d "$target_dir" && ! -L "$target_dir" && -w "$target_dir" && -x "$target_dir" ]] || return 1
  done

  [[ (! -e "$completion_marker" && ! -L "$completion_marker") ||
    -f "$completion_marker" || -L "$completion_marker" ]] || return 1
  rm -f -- "$completion_marker" || return 1
  [[ ! -e "$completion_marker" && ! -L "$completion_marker" ]] || return 1
  sync -f "$bundle/state" || return 1
  frequency_tx_kill_at state-synced

  frequency_tx_binding_prepare "$work" "$transaction" "$bundle_id" || {
    echo "error: could not create or adopt the frequency publication fence" >&2
    return 1
  }
  frequency_tx_binding_validate "$work" "$transaction" "$bundle_id" || return 1
  frequency_tx_kill_at work-ready

  # PREPARED is published only behind the exact, directory-synced bundle
  # fence. Consequently every durable journal authorizes candidate/evidence
  # mutation while excluding every other bundle publisher.
  if ((journal_present == 0)); then
    frequency_tx_journal_write "$journal" "$journal_tmp" PREPARED \
      "$transaction" "$bundle_id" "$cap_cleanup" "$commands_stage_sha" \
      "$commands_base" "$commands_final_sha" artifact_rels artifact_shas \
      artifact_bases delete_rels delete_bases || return 1
    journal_present=1
    journal_state=PREPARED
  fi
  frequency_tx_kill_at journal-prepared

  current="$(frequency_tx_path_state "$commands_destination" "$command_limit")" || return 1
  if [[ "$current" == "$commands_base" && "$current" != "F:$commands_final_sha" ]]; then
    frequency_tx_command_candidate_prepare "$stage" "$commands_destination" "$staged_commands" \
      "$command_candidate" "$commands_stage_sha" "$commands_base" "$commands_final_sha" || return 1
  elif [[ "$current" == "F:$commands_final_sha" ]]; then
    if [[ -e "$command_candidate" || -L "$command_candidate" ||
      -e "${command_candidate}.copying" || -L "${command_candidate}.copying" ]]; then
      frequency_tx_private_file_is_safe "$staged_commands" &&
        [[ "$(frequency_tx_sha256 "$staged_commands" "$staged_command_limit")" == "$commands_stage_sha" ]] || return 1
      for path in "$command_candidate" "${command_candidate}.copying"; do
        [[ -e "$path" || -L "$path" ]] || continue
        frequency_tx_private_file_is_safe "$path" || return 1
        rm -f -- "$path" || return 1
      done
      sync -f "$bundle" || return 1
    fi
  else
    return 1
  fi

  for index in "${!artifact_rels[@]}"; do
    rel="${artifact_rels[$index]}"
    path="$stage/$rel"
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    current="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
    candidate="$(frequency_tx_candidate_path "$bundle" "$rel")" || return 1
    if [[ -e "$path" || -L "$path" ]]; then
      frequency_tx_candidate_prepare "$path" "$candidate" "$bundle/$rel" \
        "${artifact_shas[$index]}" "$limit" || return 1
    elif [[ "$current" == "F:${artifact_shas[$index]}" ]]; then
      if [[ -e "${candidate}.copying" || -L "${candidate}.copying" ]]; then return 1; fi
      if [[ -e "$candidate" || -L "$candidate" ]]; then
        frequency_tx_private_file_is_safe "$candidate" &&
          [[ "$(frequency_tx_sha256 "$candidate" "$limit")" == "${artifact_shas[$index]}" ]] || return 1
      fi
    else
      return 1
    fi
  done
  frequency_tx_candidate_inventory_is_safe "$bundle" "$command_candidate" all_artifacts || return 1

  local deleted=0 installed=0
  for index in "${!delete_rels[@]}"; do
    rel="${delete_rels[$index]}"
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    current="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
    if [[ "$current" != A ]]; then
      [[ "$current" == "${delete_bases[$index]}" ]] || return 1
      rm -f -- "$bundle/$rel" || return 1
      ((deleted += 1))
      if ((deleted == 1)); then
        if [[ "${DIAG_TEST_FREQUENCY_PUBLISH_KILL_AFTER_FIRST_CAP_DELETE:-0}" == 1 ]]; then
          kill -KILL "$BASHPID"
        fi
        frequency_tx_kill_at first-delete
      fi
    fi
  done

  for index in "${!artifact_rels[@]}"; do
    rel="${artifact_rels[$index]}"
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    current="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
    if [[ "$current" != "F:${artifact_shas[$index]}" ]]; then
      [[ "$current" == "${artifact_bases[$index]}" ]] || return 1
      candidate="$(frequency_tx_candidate_path "$bundle" "$rel")" || return 1
      frequency_tx_private_file_is_safe "$candidate" &&
        [[ "$(frequency_tx_sha256 "$candidate" "$limit")" == "${artifact_shas[$index]}" ]] &&
        frequency_tx_same_device "$candidate" "$bundle/$rel" || return 1
      mv -fT -- "$candidate" "$bundle/$rel" || return 1
      sync -f "$bundle/$rel" || return 1
      sync -f "$(dirname -- "$bundle/$rel")" || return 1
      ((installed += 1))
      if ((installed == 1)); then
        if [[ "${DIAG_TEST_FREQUENCY_PUBLISH_KILL_AFTER_FIRST_MOVE:-0}" == 1 ]]; then
          kill -KILL "$BASHPID"
        fi
        frequency_tx_kill_at first-artifact-installed
      fi
    fi
  done

  current="$(frequency_tx_path_state "$commands_destination" "$command_limit")" || return 1
  if [[ "$current" != "F:$commands_final_sha" ]]; then
    [[ "$current" == "$commands_base" ]] || return 1
    frequency_tx_private_file_is_safe "$command_candidate" &&
      [[ "$(frequency_tx_sha256 "$command_candidate" "$final_command_limit")" == "$commands_final_sha" ]] &&
      frequency_tx_same_device "$command_candidate" "$commands_destination" || return 1
    mv -fT -- "$command_candidate" "$commands_destination" || return 1
    sync -f "$commands_destination" || return 1
    sync -f "$bundle" || return 1
  fi
  frequency_tx_kill_at commands-published

  # Commit verification precedes every source or journal unlink.
  for index in "${!artifact_rels[@]}"; do
    rel="${artifact_rels[$index]}"
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    current="$(frequency_tx_path_state "$bundle/$rel" "$limit")" || return 1
    [[ "$current" == "F:${artifact_shas[$index]}" ]] || return 1
  done
  for rel in "${delete_rels[@]}"; do
    limit="$(frequency_tx_artifact_limit "$rel")" || return 1
    [[ "$(frequency_tx_path_state "$bundle/$rel" "$limit")" == A ]] || return 1
  done
  [[ "$(frequency_tx_path_state "$commands_destination" "$command_limit")" == "F:$commands_final_sha" ]] || return 1
  sync -f "$bundle/results" || return 1
  sync -f "$bundle/freq" || return 1
  sync -f "$bundle/state" || return 1
  sync -f "$bundle" || return 1

  # Durable commit is the one-way boundary. Once this rewrite lands, retries
  # never inspect or alter bundle evidence/commands; they only finish cleanup.
  frequency_tx_journal_write "$journal" "$journal_tmp" COMMITTED \
    "$transaction" "$bundle_id" "$cap_cleanup" "$commands_stage_sha" \
    "$commands_base" "$commands_final_sha" artifact_rels artifact_shas \
    artifact_bases delete_rels delete_bases || return 1
  journal_state=COMMITTED
  frequency_tx_kill_at journal-committed
  frequency_tx_cleanup_committed "$stage" "$bundle" "$work" "$journal" "$journal_tmp" \
    "$control" "$staged_commands" "$transaction" "$bundle_id" "$command_candidate" \
    artifact_rels all_artifacts
}
