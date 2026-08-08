import test from "node:test";
import assert from "node:assert/strict";

import { buildRoundOrders, expandCpuList } from "../../targeted-cpu-test.mjs";

test("expandCpuList accepts ordered lists and ranges", () => {
  assert.deepEqual(expandCpuList("8-11,19,21"), [8, 9, 10, 11, 19, 21]);
  assert.throws(() => expandCpuList("11,11"), /duplicate/);
  assert.throws(() => expandCpuList("11-8"), /descending/);
});

test("one-to-one keeps one stable slot per CPU", () => {
  assert.deepEqual(buildRoundOrders("one-to-one", [8, 9, 10, 11], 2, 7), [
    [8, 9, 10, 11],
    [8, 9, 10, 11],
  ]);
});

test("interleaved scheduling is deterministic and balanced", () => {
  const first = buildRoundOrders("interleaved", [10, 11, 18, 19, 21, 22], 8, 20260808);
  const second = buildRoundOrders("interleaved", [10, 11, 18, 19, 21, 22], 8, 20260808);
  assert.deepEqual(first, second);
  assert.ok(new Set(first.map((round) => round.join(","))).size > 1);
  for (const round of first) assert.deepEqual([...round].sort((a, b) => a - b), [10, 11, 18, 19, 21, 22]);
});
