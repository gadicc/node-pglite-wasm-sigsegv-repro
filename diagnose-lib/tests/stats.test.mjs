import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wilson,
  zeroFailureUpperBound,
  fisherExact2x2,
  binomZeroProbability,
  summarize,
} from "../stats.mjs";

const closeTo = (actual, expected, tol = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} ≈ ${expected} (tol ${tol})`,
  );

test("wilson: 0/20 has zero lower bound and ~0.1611 upper", () => {
  const w = wilson(0, 20);
  assert.equal(w.low, 0);
  closeTo(w.high, 0.16112515805281938, 1e-9);
});

test("wilson: 6/20 interval", () => {
  const w = wilson(6, 20);
  closeTo(w.low, 0.1454772, 1e-4);
  closeTo(w.high, 0.5189728, 1e-4);
});

test("wilson: all failures keeps upper bound at 1", () => {
  const w = wilson(20, 20);
  closeTo(w.high, 1, 1e-12);
  assert.ok(w.low > 0.8);
});

test("wilson: rejects invalid input", () => {
  assert.throws(() => wilson(-1, 10));
  assert.throws(() => wilson(11, 10));
  assert.throws(() => wilson(1, 0));
  assert.throws(() => wilson(0.5, 10));
});

test("zeroFailureUpperBound: exact 95% bound, rule-of-three consistent", () => {
  closeTo(zeroFailureUpperBound(20), 0.13910834066826516, 1e-9);
  // Rule of three (3/n = 0.15) approximates the exact bound within 0.012.
  assert.ok(Math.abs(zeroFailureUpperBound(20) - 3 / 20) < 0.012);
  closeTo(zeroFailureUpperBound(50), 1 - Math.pow(0.05, 1 / 50), 1e-12);
  assert.throws(() => zeroFailureUpperBound(0));
});

test("fisherExact2x2: lady tasting tea reference value", () => {
  // Classic Fisher example [[3,1],[1,3]] two-sided p = 0.485714...
  closeTo(fisherExact2x2(3, 1, 1, 3), 0.4857142857142857, 1e-9);
});

test("fisherExact2x2: extreme table is highly significant", () => {
  const p = fisherExact2x2(20, 0, 0, 20);
  assert.ok(p < 1e-9, `expected tiny p, got ${p}`);
});

test("fisherExact2x2: identical rates give p = 1", () => {
  closeTo(fisherExact2x2(5, 15, 10, 30), 1, 1e-9);
});

test("fisherExact2x2: symmetric in group order", () => {
  closeTo(fisherExact2x2(1, 9, 5, 5), fisherExact2x2(5, 5, 1, 9), 1e-12);
});

test("binomZeroProbability: README's ~8e-5 example", () => {
  // 0/20 under an assumed fixed 37.5% per-run rate.
  closeTo(binomZeroProbability(20, 0.375), 0.00008271806125530277, 1e-12);
  assert.equal(binomZeroProbability(10, 0), 1);
  assert.throws(() => binomZeroProbability(0, 0.5));
});

test("summarize: bundles rate, CI, and zero-failure bound", () => {
  const s = summarize(0, 20);
  assert.equal(s.rate, 0);
  closeTo(s.zeroFailureUpper95, 0.13910834066826516, 1e-9);
  const s2 = summarize(6, 20);
  assert.equal(s2.zeroFailureUpper95, undefined);
  closeTo(s2.rate, 0.3, 1e-12);
});
