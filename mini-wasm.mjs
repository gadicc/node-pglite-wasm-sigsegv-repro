// mini-wasm.mjs — minimal V8/wasm trigger probe, no dependencies.
//
// Hand-encoded module: memory(1 page) + spin(n) which calls bump() n times;
// bump() increments memory[0]. Liftoff/Turbofan emit the same per-call
// budget-bump shape captured in the pglite crashes (addl $1, 0x1c0(%r13)).
// The JS side verifies memory[0] after every spin, so silent corruption of
// the counter is caught as well as SIGSEGV.
//
// Usage: taskset -c 19 node mini-wasm.mjs [spins]

const bytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  // type section: type0 (i32)->i32 (spin), type1 ()->() (bump)
  0x01, 0x09, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x00,
  // function section: func0=type0, func1=type1
  0x03, 0x03, 0x02, 0x00, 0x01,
  // memory section: 1 page, no max
  0x05, 0x03, 0x01, 0x00, 0x01,
  // export section: "spin"=func0, "mem"=memory0
  0x07, 0x0e, 0x02, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00, 0x03, 0x6d,
  0x65, 0x6d, 0x02, 0x00,
  // code section
  0x0a, 0x2f, 0x02,
  // func0 spin(n)->i32: block; loop; br_if exit if n==0; call bump; n--;
  // br loop; end; end; return mem[0]
  0x1d, 0x00, 0x02, 0x40, 0x03, 0x40, 0x20, 0x00, 0x45, 0x0d, 0x01, 0x10,
  0x01, 0x20, 0x00, 0x41, 0x01, 0x6b, 0x21, 0x00, 0x0c, 0x00, 0x0b, 0x0b,
  0x41, 0x00, 0x28, 0x02, 0x00, 0x0b,
  // func1 bump(): mem[0] = mem[0] + 1
  0x0f, 0x00, 0x41, 0x00, 0x41, 0x00, 0x28, 0x02, 0x00, 0x41, 0x01, 0x6a,
  0x36, 0x02, 0x00, 0x0b,
]);

const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
const { spin, mem } = inst.exports;
const view = new DataView(mem.buffer);

const SPINS = Number(process.argv[2] || 1000000);
const LOG_EVERY = Number(process.argv[3] || 10000);
let expected = 0;
let round = 0;
for (;;) {
  const got = spin(SPINS);
  expected = (expected + SPINS) >>> 0;
  round++;
  if (got >>> 0 !== expected) {
    console.error(
      `DATA MISMATCH round=${round} expected=${expected} got=${got >>> 0} (silent corruption)`,
    );
    process.exit(43);
  }
  if (round % LOG_EVERY === 0) console.error(`round=${round} ok`);
}
