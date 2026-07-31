CPU="${1:-19}"
if [[ ! "$CPU" =~ ^[0-9]+$ ]]; then
  printf 'usage: %s [cpu]\n' "$0" >&2
  exit 2
fi
echo "Checking CPU $CPU..."

pass=0
fail=0

for ((i = 1; i <= 20; i++)); do
  printf '%02d... ' "$i"

  taskset -c "$CPU" node child.mjs
  rc=$?

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