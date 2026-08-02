// stats.mjs - statistical helpers for the diagnostic runner.
//
// Pure functions, no dependencies, usable as a module (import) or as a CLI:
//   node stats.mjs wilson <failures> <n>
//   node stats.mjs zero-upper <n> [confidence]
//   node stats.mjs fisher <a> <b> <c> <d>
//   node stats.mjs binom-zero <n> <rate>
//   node stats.mjs permutation-cpu <iterations> <f1> <n1> [<f2> <n2> ...]
//
// All probability computations use log-space arithmetic so they stay
// accurate for the sample sizes this project produces (tens to thousands).

const DEFAULT_CONFIDENCE = 0.95;
// z for a two-sided 95% interval.
const Z95 = 1.959963984540054;

function logGamma(x) {
  // Lanczos approximation (g = 7, 9 coefficients), Numerical Recipes.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
    );
  }
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinom(n, k) {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

// Wilson score interval for a binomial proportion.
// Returns { low, high, center } with 0 <= low <= center <= high <= 1.
export function wilson(failures, n, z = Z95) {
  if (!Number.isInteger(failures) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`wilson: invalid arguments failures=${failures} n=${n}`);
  }
  if (failures < 0 || failures > n) {
    throw new Error(`wilson: failures ${failures} out of range for n=${n}`);
  }
  const p = failures / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
    center,
  };
}

// Exact one-sided upper confidence bound for the failure rate after
// observing zero failures in n trials: the smallest rate p such that
// P(0 failures | p) <= 1 - confidence. For confidence 0.95 this is
// 1 - 0.05^(1/n), closely approximated by the "rule of three" 3/n.
export function zeroFailureUpperBound(n, confidence = DEFAULT_CONFIDENCE) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`zeroFailureUpperBound: invalid n=${n}`);
  }
  return 1 - Math.pow(1 - confidence, 1 / n);
}

// Hypergeometric probability of a 2x2 table with fixed margins:
//           col1   col2
//   row1     a      b     (row1 = a+b)
//   row2     c      d     (row2 = c+d, n = a+b+c+d)
// P(a) = C(r1, a) * C(r2, col1 - a) / C(n, col1)
function hypergeomProb(a, r1, r2, col1, n) {
  return Math.exp(logBinom(r1, a) + logBinom(r2, col1 - a) - logBinom(n, col1));
}

// Fisher's exact test, two-sided (sum of tables at most as probable as the
// observed table). a/b = failures/non-failures in group 1, c/d in group 2.
export function fisherExact2x2(a, b, c, d) {
  for (const v of [a, b, c, d]) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`fisherExact2x2: invalid cell value ${v}`);
    }
  }
  const r1 = a + b;
  const r2 = c + d;
  const col1 = a + c;
  const n = r1 + r2;
  if (n === 0) return 1;

  const lo = Math.max(0, col1 - r2);
  const hi = Math.min(r1, col1);
  const pObs = hypergeomProb(a, r1, r2, col1, n);
  let p = 0;
  for (let x = lo; x <= hi; x += 1) {
    const px = hypergeomProb(x, r1, r2, col1, n);
    // Tolerance guards floating-point jitter around equal probabilities.
    if (px <= pObs * (1 + 1e-9)) p += px;
  }
  return Math.min(1, p);
}

// Probability of observing zero failures in n independent trials if the
// true per-trial failure rate were `rate`. This is NOT a confidence
// statement; callers must label the assumed baseline rate explicitly.
export function binomZeroProbability(n, rate) {
  if (!Number.isInteger(n) || n <= 0 || rate < 0 || rate > 1) {
    throw new Error(`binomZeroProbability: invalid n=${n} rate=${rate}`);
  }
  return Math.pow(1 - rate, n);
}

// mulberry32 PRNG (public domain, by Tommy Ettinger). Small and fast; used
// with a FIXED seed so that identical inputs produce identical reports.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed seed for the permutation test: reports must be reproducible.
const PERMUTATION_SEED = 0x5eed;
export const DEFAULT_PERMUTATION_ITERATIONS = 20000;

// Pearson chi-square statistic of the 2 x K table (failure/clean x CPUs)
// against the per-CPU expected counts under a common per-run failure rate.
function chiSquareFromExpected(failures, expected) {
  let stat = 0;
  for (let k = 0; k < failures.length; k += 1) {
    const e = expected[k];
    if (e.expF > 0) stat += ((failures[k] - e.expF) ** 2) / e.expF;
    const clean = e.runs - failures[k];
    if (e.expC > 0) stat += ((clean - e.expC) ** 2) / e.expC;
  }
  return stat;
}

// Permutation omnibus test for CPU localization. Null hypothesis: every run
// has the same failure probability regardless of CPU. The failure labels are
// shuffled uniformly among all runs with per-CPU run counts held fixed, and
// p is the fraction of permutations whose chi-square statistic is at least
// the observed one, with the +1 correction (the observed table is itself a
// possible permutation), so 0 < p <= 1 always.
//
// counts = [{ failures, runs }, ...] per tested CPU. This is valid where a
// Fisher test on a post-hoc failing-vs-clean grouping is not: the grouping
// is never derived from the observed outcomes.
export function permutationCpuTest(counts, iterations = DEFAULT_PERMUTATION_ITERATIONS) {
  for (const c of counts) {
    if (
      !Number.isInteger(c?.failures) || !Number.isInteger(c?.runs) ||
      c.failures < 0 || c.runs < 0 || c.failures > c.runs
    ) {
      throw new Error(`permutationCpuTest: invalid counts entry ${JSON.stringify(c)}`);
    }
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`permutationCpuTest: invalid iterations=${iterations}`);
  }
  const totalRuns = counts.reduce((s, c) => s + c.runs, 0);
  const totalFailures = counts.reduce((s, c) => s + c.failures, 0);
  // Expected counts depend only on the fixed margins, so they are computed
  // once and shared by the observed table and every permutation.
  const expected = counts.map((c) => {
    const expF = totalRuns > 0 ? (c.runs * totalFailures) / totalRuns : 0;
    return { runs: c.runs, expF, expC: c.runs - expF };
  });
  const observed = chiSquareFromExpected(counts.map((c) => c.failures), expected);
  // One label per run; exactly totalFailures of them are failures.
  const labels = new Array(totalRuns).fill(0);
  for (let i = 0; i < totalFailures; i += 1) labels[i] = 1;
  const permFailures = new Array(counts.length).fill(0);
  const rand = mulberry32(PERMUTATION_SEED);
  let extreme = 0;
  for (let it = 0; it < iterations; it += 1) {
    // Fisher-Yates shuffle with the seeded PRNG.
    for (let i = labels.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = labels[i];
      labels[i] = labels[j];
      labels[j] = tmp;
    }
    // Deal the shuffled labels to the CPUs in order, run counts fixed.
    let offset = 0;
    for (let k = 0; k < counts.length; k += 1) {
      let f = 0;
      for (let run = 0; run < expected[k].runs; run += 1) f += labels[offset + run];
      offset += expected[k].runs;
      permFailures[k] = f;
    }
    if (chiSquareFromExpected(permFailures, expected) >= observed - 1e-9) extreme += 1;
  }
  return { p: (extreme + 1) / (iterations + 1), statistic: observed, iterations };
}

// Convenience bundle for one group's counts.
export function summarize(failures, n) {
  const w = wilson(failures, n);
  const out = {
    failures,
    attempts: n,
    rate: n > 0 ? failures / n : null,
    wilson95Low: w.low,
    wilson95High: w.high,
  };
  if (failures === 0) {
    out.zeroFailureUpper95 = zeroFailureUpperBound(n);
  }
  return out;
}

function cli(argv) {
  const [op, ...rest] = argv;
  const nums = rest.map(Number);
  let out;
  switch (op) {
    case "wilson":
      out = wilson(nums[0], nums[1]);
      break;
    case "zero-upper":
      out = { upper95: zeroFailureUpperBound(nums[0], nums[1] ?? DEFAULT_CONFIDENCE) };
      break;
    case "fisher":
      out = { pTwoSided: fisherExact2x2(nums[0], nums[1], nums[2], nums[3]) };
      break;
    case "binom-zero":
      out = { probability: binomZeroProbability(nums[0], nums[1]) };
      break;
    case "summarize":
      out = summarize(nums[0], nums[1]);
      break;
    case "permutation-cpu": {
      const [iterations, ...pairs] = nums;
      if (pairs.length === 0 || pairs.length % 2 !== 0) {
        console.error("permutation-cpu: expected <iterations> then <failures> <runs> pairs");
        process.exitCode = 2;
        return;
      }
      const counts = [];
      for (let i = 0; i < pairs.length; i += 2) {
        counts.push({ failures: pairs[i], runs: pairs[i + 1] });
      }
      out = permutationCpuTest(counts, iterations);
      break;
    }
    default:
      console.error(
        "usage: node stats.mjs <wilson|zero-upper|fisher|binom-zero|summarize|permutation-cpu> ...",
      );
      process.exitCode = 2;
      return;
  }
  console.log(JSON.stringify(out));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2));
}
