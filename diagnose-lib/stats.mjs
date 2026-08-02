// stats.mjs - statistical helpers for the diagnostic runner.
//
// Pure functions, no dependencies, usable as a module (import) or as a CLI:
//   node stats.mjs wilson <failures> <n>
//   node stats.mjs zero-upper <n> [confidence]
//   node stats.mjs fisher <a> <b> <c> <d>
//   node stats.mjs fisher-greater <a> <b> <c> <d>
//   node stats.mjs binom-zero <n> <rate>
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

// Fisher's exact one-sided upper-tail test for a greater failure rate in
// group 1 than group 2. With fixed margins, sum every supported table whose
// group-1 failure count is at least the observed count.
export function fisherExactGreater(a, b, c, d) {
  for (const v of [a, b, c, d]) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new Error(`fisherExactGreater: invalid cell value ${v}`);
    }
  }
  const r1 = a + b;
  const r2 = c + d;
  const col1 = a + c;
  const n = r1 + r2;
  if (!Number.isSafeInteger(r1) || !Number.isSafeInteger(r2) ||
      !Number.isSafeInteger(col1) || !Number.isSafeInteger(n)) {
    throw new Error("fisherExactGreater: table totals exceed the safe integer range");
  }
  if (n === 0) return 1;
  const hi = Math.min(r1, col1);
  let p = 0;
  for (let x = a; x <= hi; x += 1) {
    p += hypergeomProb(x, r1, r2, col1, n);
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
    case "fisher-greater":
      out = { pGreater: fisherExactGreater(nums[0], nums[1], nums[2], nums[3]) };
      break;
    case "binom-zero":
      out = { probability: binomZeroProbability(nums[0], nums[1]) };
      break;
    case "summarize":
      out = summarize(nums[0], nums[1]);
      break;
    default:
      console.error(
        "usage: node stats.mjs <wilson|zero-upper|fisher|fisher-greater|binom-zero|summarize> ...",
      );
      process.exitCode = 2;
      return;
  }
  console.log(JSON.stringify(out));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2));
}
