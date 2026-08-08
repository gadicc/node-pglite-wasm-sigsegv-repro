#!/usr/bin/env bash
# Minimal common launcher used by targeted-cpu-test.mjs. Keeping both targeted
# protocols behind this one entry point makes their process setup comparable.
set -u

if [[ $# -ne 3 || ! "$1" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "usage: run-pinned-child.sh <cpu> <node-bin> <child.mjs>" >&2
  exit 125
fi

cpu="$1"
node_bin="$2"
child="$3"

command -v taskset > /dev/null 2>&1 || {
  echo "error: taskset is required" >&2
  exit 125
}
[[ -x "$node_bin" && -f "$child" && ! -L "$child" ]] || {
  echo "error: unsafe or missing Node/child path" >&2
  exit 125
}

ulimit -c 0
exec taskset -c "$cpu" "$node_bin" "$child"
