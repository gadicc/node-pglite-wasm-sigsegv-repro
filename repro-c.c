/*
 * repro-c.c — native (no Node/V8) trigger attempt for the CPU-localized
 * single-bit fault-address corruption documented in README.md
 * ("Platform-level fault-address investigation").
 *
 * Rationale
 *
 * Every gdb capture of the Node/PGlite crash shows the same shape: the
 * glitch lands on the dominant register-relative memory access of the
 * workload — V8's per-wasm-call budget bump through the pinned instance
 * register:
 *
 *     addl $1, 0x1c0(%r13)     (also: mov %rbp,0xb0(%r13), mov %r10,0xa8(%r13))
 *     call *%rdx
 *
 * The base register reads back clean, yet si_addr = intended + 2^42: a
 * single high bit set downstream of the register file. A randomly-timed
 * glitch lands on whichever memory access is in flight, so this program
 * makes its own dynamic instruction stream consist almost entirely of
 * exactly that shape:
 *
 *   - a tight loop of `addl $1, disp(%r13)` RMWs plus loads/stores through
 *     two long-lived base pointers (r13 = object A, r15 = object B),
 *   - one indirect call (`call *%rdx`) per iteration to a callee that
 *     performs the same budget-bump shape on object B,
 *   - batch verification of every counter and stored value, so a flip onto
 *     a *mapped* page (silent corruption: our counter loses an increment,
 *     or foreign memory receives one) is caught too — not only flips onto
 *     unmapped pages (SIGSEGV).
 *
 * Detection
 *
 *   - SIGSEGV: a SA_SIGINFO handler prints si_addr, RIP, the instruction
 *     bytes at RIP, and the GP registers from ucontext — the same evidence
 *     as the gdb captures, without gdb — then exits 42.
 *   - Silent corruption: batch counter/value verification; exits 43 with
 *     the offset, expected and observed values on mismatch.
 *
 * Exit codes: 0 pass, 42 SIGSEGV captured, 43 data mismatch, 1 setup
 * error, 2 usage error.
 *
 * Build: cc -O2 -Wall -Wextra -o repro-c repro-c.c
 * Run:   taskset -c 19 ./repro-c [--cpu 19] [--iters N] [--batch N]
 */

#define _GNU_SOURCE
#include <inttypes.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>

/* Field offsets within each hot object (one anonymous page each). */
#define OFF_C0 0x000u /* addl $1 target #1                        */
#define OFF_C1 0x040u /* addl $1 target #2                        */
#define OFF_V0 0x080u /* load source (constant, verified)         */
#define OFF_S0 0x0a8u /* store target (pattern, verified)         */
#define OFF_S1 0x0b0u /* store target (copy of V0, verified)      */
#define OFF_C2 0x100u /* addl $1 target #3                        */
#define OFF_C3 0x180u /* addl $1 target #4                        */
#define OFF_C4 0x1c0u /* addl $1 target #5 (the captured offset)  */
#define OFF_CB 0x1c0u /* object B counter, bumped by the callee   */

#define V0_INIT UINT64_C(0x1122334455667788)
#define S0_PATTERN UINT64_C(0x5a5a5a5a5a5a5a5a)

/* Memory-accessing instructions per loop iteration (loop body + callee). */
#define MEMOPS_PER_ITER 10

extern unsigned long hotloop(unsigned char *a, unsigned char *b,
                             void *const *ftab, unsigned long iters);
extern void hotcallee(void);

/* liftoff-clone mode. */
extern char clone_begin[], clone_end[], spin_clone[], spin_imm[];
extern uint32_t clone_entry(void *code, void *instance, void *budget,
                            uint32_t n);

/* Extra state for the TLB-pressure variant (hotloop2). */
struct span_args {
  unsigned char *span;      /* large region, one RMW per iteration   */
  const uint64_t *offs;     /* shuffled per-page byte offsets        */
  const uint64_t *offs_end; /* wrap point                            */
};
extern unsigned long hotloop2(unsigned char *a, unsigned char *b,
                              void *const *ftab, unsigned long iters,
                              const struct span_args *sp);

/*
 * The hot loop. Kept in assembly so the instruction stream is exactly the
 * intended shape: register-relative RMW/loads/stores off r13/r15 with an
 * indirect call per iteration, mirroring the captured wasm code.
 *
 * hotloop(a=rdi, b=rsi, ftab=rdx, iters=rcx)
 *   r13 = object A base, r15 = object B base, r14 = ftab, rbx = iters,
 *   r12 = store pattern; hotcallee bumps 0x1c0(%r15) and must stay a leaf.
 */
__asm__(
    ".text\n"
    ".globl hotcallee\n"
    ".type hotcallee,@function\n"
    "hotcallee:\n"
    "    endbr64\n"
    "    addl $1, 0x1c0(%r15)\n"
    "    ret\n"
    ".size hotcallee, .-hotcallee\n"

    ".globl hotloop\n"
    ".type hotloop,@function\n"
    "hotloop:\n"
    "    endbr64\n"
    "    push %rbp\n"
    "    push %rbx\n"
    "    push %r12\n"
    "    push %r13\n"
    "    push %r14\n"
    "    push %r15\n"
    "    sub  $8, %rsp\n"
    "    mov  %rdi, %r13\n"
    "    mov  %rsi, %r15\n"
    "    mov  %rdx, %r14\n"
    "    mov  %rcx, %rbx\n"
    "    movabs $0x5a5a5a5a5a5a5a5a, %r12\n"
    ".Lhotloop_iter:\n"
    "    addl $1, 0x000(%r13)\n"
    "    addl $1, 0x040(%r13)\n"
    "    mov  0x080(%r13), %rax\n"
    "    mov  %r12, 0x0a8(%r13)\n"
    "    mov  %rax, 0x0b0(%r13)\n"
    "    addl $1, 0x100(%r13)\n"
    "    addl $1, 0x180(%r13)\n"
    "    addl $1, 0x1c0(%r13)\n"
    "    mov  (%r14), %rdx\n"
    "    call *%rdx\n"
    "    dec  %rbx\n"
    "    jne  .Lhotloop_iter\n"
    "    xor  %eax, %eax\n"
    "    add  $8, %rsp\n"
    "    pop  %r15\n"
    "    pop  %r14\n"
    "    pop  %r13\n"
    "    pop  %r12\n"
    "    pop  %rbx\n"
    "    pop  %rbp\n"
    "    ret\n"
    ".size hotloop, .-hotloop\n"

    /*
     * hotloop2(a=rdi, b=rsi, ftab=rdx, iters=rcx, sp=r8): same hot shape,
     * plus one RMW into a large span per iteration (shuffled page order) to
     * keep the dTLB / page-walk path busy. r8=span, r9=offs cursor,
     * r10=offs end, rbp=offs start (wrap), r11=scratch offset.
     */
    ".globl hotloop2\n"
    ".type hotloop2,@function\n"
    "hotloop2:\n"
    "    endbr64\n"
    "    push %rbp\n"
    "    push %rbx\n"
    "    push %r12\n"
    "    push %r13\n"
    "    push %r14\n"
    "    push %r15\n"
    "    sub  $8, %rsp\n"
    "    mov  %rdi, %r13\n"
    "    mov  %rsi, %r15\n"
    "    mov  %rdx, %r14\n"
    "    mov  %rcx, %rbx\n"
    "    movabs $0x5a5a5a5a5a5a5a5a, %r12\n"
    "    mov  8(%r8), %r9\n"
    "    mov  16(%r8), %r10\n"
    "    mov  %r9, %rbp\n"
    "    mov  (%r8), %r8\n"
    ".Lhotloop2_iter:\n"
    "    addl $1, 0x000(%r13)\n"
    "    addl $1, 0x040(%r13)\n"
    "    mov  0x080(%r13), %rax\n"
    "    mov  %r12, 0x0a8(%r13)\n"
    "    mov  %rax, 0x0b0(%r13)\n"
    "    addl $1, 0x100(%r13)\n"
    "    addl $1, 0x180(%r13)\n"
    "    addl $1, 0x1c0(%r13)\n"
    "    mov  (%r14), %rdx\n"
    "    call *%rdx\n"
    "    mov  (%r9), %r11\n"
    "    addl $1, (%r8,%r11)\n"
    "    add  $8, %r9\n"
    "    cmp  %r10, %r9\n"
    "    jb   1f\n"
    "    mov  %rbp, %r9\n"
    "1:\n"
    "    dec  %rbx\n"
    "    jne  .Lhotloop2_iter\n"
    "    xor  %eax, %eax\n"
    "    add  $8, %rsp\n"
    "    pop  %r15\n"
    "    pop  %r14\n"
    "    pop  %r13\n"
    "    pop  %r12\n"
    "    pop  %rbx\n"
    "    pop  %rbp\n"
    "    ret\n"
    ".size hotloop2, .-hotloop2\n"

    /*
     * liftoff-clone mode: a position-independent re-creation of the
     * Liftoff-generated code for mini-wasm.mjs (spin/bump), copied into a
     * fresh RWX mapping at runtime and executed there — the same class of
     * code, memory layout, and register conventions as the crashing V8
     * workload:
     *   r13 = instance pointer (fields at [r13-0x60] stack-check word and
     *         [r13+0x1f] linear-memory base, as Liftoff emits them),
     *   budget bump `addl $1, 0x13(%rax)` with rax reloaded from the frame,
     *   calls through a jump-table stub, bump() doing mem[0]++.
     * clone_entry(code=rdi, instance=rsi, budget=rdx, n=ecx) -> eax = mem[0].
     */
    ".globl clone_entry\n"
    ".type clone_entry,@function\n"
    "clone_entry:\n"
    "    endbr64\n"
    "    push %rbp\n"
    "    push %r12\n"
    "    push %r13\n"
    "    push %r14\n"
    "    sub  $8, %rsp\n"
    "    mov  %rsi, %r13\n"
    "    add  $0x100, %r13\n"
    "    mov  %r13, %rsi\n"
    "    mov  %rdx, %r14\n"
    "    mov  %ecx, %eax\n"
    "    call *%rdi\n"
    "    add  $8, %rsp\n"
    "    pop  %r14\n"
    "    pop  %r13\n"
    "    pop  %r12\n"
    "    pop  %rbp\n"
    "    ret\n"
    ".size clone_entry, .-clone_entry\n"

    ".globl clone_begin\n"
    ".globl clone_end\n"
    ".globl spin_clone\n"
    ".globl spin_imm\n"
    "clone_begin:\n"
    "spin_clone:\n"
    "    endbr64\n"
    "    push %rbp\n"
    "    mov  %rsp, %rbp\n"
    "    sub  $0x30, %rsp\n"
    "    .byte 0x41, 0xc7, 0xc4\n" /* movl $imm32, %r12d */
    "spin_imm:\n"
    "    .long 0\n" /* patched per round in churn mode; r12 is otherwise dead */
    "    movl %eax, -0x24(%rbp)\n"
    "    mov  %rsi, -0x10(%rbp)\n"
    "    mov  %r14, -0x18(%rbp)\n"
    ".Lspin_head:\n"
    "    cmp  %rsp, -0x60(%r13)\n"
    "    jna  .Lspin_stackfail\n"
    "    movl -0x24(%rbp), %eax\n"
    "    test %eax, %eax\n"
    "    jz   .Lspin_done\n"
    "    mov  -0x18(%rbp), %rax\n"
    "    addl $1, 0x13(%rax)\n"
    "    call .Ljt_bump\n"
    "    movl -0x24(%rbp), %eax\n"
    "    movl $1, %ecx\n"
    "    subl %ecx, %eax\n"
    "    movl %eax, -0x24(%rbp)\n"
    "    mov  -0x10(%rbp), %rsi\n"
    "    jmp  .Lspin_head\n"
    ".Lspin_done:\n"
    "    mov  -0x10(%rbp), %rsi\n"
    "    mov  0x1f(%rsi), %rax\n"
    "    movl (%rax), %ecx\n"
    "    movl %ecx, %eax\n"
    "    leave\n"
    "    ret\n"
    ".Lspin_stackfail:\n"
    "    ud2\n"
    ".Ljt_bump:\n"
    "    jmp bump_clone\n"
    "bump_clone:\n"
    "    endbr64\n"
    "    push %rbp\n"
    "    mov  %rsp, %rbp\n"
    "    sub  $8, %rsp\n"
    "    cmp  %rsp, -0x60(%r13)\n"
    "    jna  .Lbump_stackfail\n"
    "    mov  0x1f(%rsi), %rax\n"
    "    movl (%rax), %ecx\n"
    "    addl $1, %ecx\n"
    "    movl %ecx, (%rax)\n"
    "    leave\n"
    "    ret\n"
    ".Lbump_stackfail:\n"
    "    ud2\n"
    "clone_end:\n"
    ".text\n");

/* ------------------------------------------------------------------ */
/* SIGSEGV evidence capture (async-signal-safe: write(2) only).        */
/* ------------------------------------------------------------------ */

/* Regions registered by the active mode, for si_addr displacement analysis. */
static struct region {
  const char *name;
  uintptr_t base;
  uint64_t size;
} g_regions[6];
static int g_nregions;

static void region_add(const char *name, const void *base, uint64_t size) {
  if (g_nregions < (int)(sizeof g_regions / sizeof g_regions[0])) {
    g_regions[g_nregions].name = name;
    g_regions[g_nregions].base = (uintptr_t)base;
    g_regions[g_nregions].size = size;
    g_nregions++;
  }
}

static void put_str(const char *s) {
  size_t n = 0;
  while (s[n] != '\0')
    n++;
  ssize_t unused = write(STDERR_FILENO, s, n);
  (void)unused;
}

static void put_hex(uint64_t v) {
  char buf[2 + 16];
  int i = 2 + 16;
  buf[0] = '0';
  buf[1] = 'x';
  while (i-- > 2) {
    buf[i] = "0123456789abcdef"[v & 0xf];
    v >>= 4;
  }
  /* Trim leading zeros but keep at least one digit. */
  const char *p = buf + 2;
  const char *end = buf + 2 + 16;
  while (p < end - 1 && *p == '0')
    p++;
  put_str("0x");
  ssize_t unused = write(STDERR_FILENO, p, (size_t)(end - p));
  (void)unused;
}

/* Compare si_addr against one region and describe the displacement. */
static void verdict(const struct region *r, uintptr_t f) {
  uint64_t d = f - r->base;
  put_str("\n  vs ");
  put_str(r->name);
  put_str(" (base=");
  put_hex(r->base);
  put_str("): diff=");
  put_hex(d);
  if (d < r->size)
    put_str("  -> INSIDE the region: harness bug, NOT the target fault");
  else if (d - (UINT64_C(1) << 42) < r->size)
    put_str("  -> intended + 2^42 + small offset: MATCHES the Node/PGlite"
            " signature");
  else if ((d & (UINT64_C(0x3ffffffffff))) < r->size && (d >> 42) != 0)
    put_str("  -> intended + single high bit(s) above bit 41");
}

static void on_segv(int sig, siginfo_t *si, void *ucv) {
  (void)sig;
  ucontext_t *uc = ucv;
  greg_t *g = uc->uc_mcontext.gregs;
  uintptr_t f = (uintptr_t)si->si_addr;

  put_str("\nFAULT si_addr=");
  put_hex(f);
  put_str(" rip=");
  put_hex((uint64_t)g[REG_RIP]);
  put_str(" instr=");
  const unsigned char *ip = (const unsigned char *)g[REG_RIP];
  for (int i = 0; i < 12; i++) {
    char b[3];
    b[0] = "0123456789abcdef"[ip[i] >> 4];
    b[1] = "0123456789abcdef"[ip[i] & 0xf];
    b[2] = ' ';
    ssize_t unused = write(STDERR_FILENO, b, 3);
    (void)unused;
  }
  put_str("\n  r13=");
  put_hex((uint64_t)g[REG_R13]);
  put_str(" r15=");
  put_hex((uint64_t)g[REG_R15]);
  put_str(" rdx=");
  put_hex((uint64_t)g[REG_RDX]);
  put_str(" rax=");
  put_hex((uint64_t)g[REG_RAX]);
  put_str(" rbx=");
  put_hex((uint64_t)g[REG_RBX]);
  put_str(" rbp=");
  put_hex((uint64_t)g[REG_RBP]);

  for (int i = 0; i < g_nregions; i++)
    verdict(&g_regions[i], f);
  put_str("\n");
  _exit(42);
}

/* ------------------------------------------------------------------ */

static void usage(const char *argv0) {
  fprintf(stderr,
          "usage: %s [--mode clone|churn|churn-mem|rmw] [--cpu N] [--iters N] "
          "[--batch N] [--span-mb N (0 disables; rmw only)] "
          "[--span-offsets N]\n",
          argv0);
  exit(2);
}

static int run_rmw(unsigned long total, unsigned long batch,
                   unsigned long span_mb, unsigned long offs_count);
static int run_clone(unsigned long total, unsigned long batch);
static int run_churn(unsigned long total, unsigned long batch);
static int run_churn_mem(unsigned long total, unsigned long batch);

static unsigned long parse_ul(const char *s, const char *flag) {
  char *end = NULL;
  unsigned long v = strtoul(s, &end, 0);
  if (end == NULL || *end != '\0') {
    fprintf(stderr, "error: bad value for %s: %s\n", flag, s);
    exit(2);
  }
  return v;
}

static uint32_t rd32(unsigned char *base, unsigned off) {
  uint32_t v;
  memcpy(&v, base + off, sizeof v);
  return v;
}

static uint64_t rd64(unsigned char *base, unsigned off) {
  uint64_t v;
  memcpy(&v, base + off, sizeof v);
  return v;
}

int main(int argc, char **argv) {
  enum { MODE_RMW, MODE_CLONE, MODE_CHURN, MODE_CHURN_MEM } mode = MODE_CLONE;
  unsigned long total = 0; /* 0 = mode default */
  unsigned long batch = 0;
  unsigned long span_mb = 1024;
  unsigned long offs_count = 4096;
  int cpu = -1;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--cpu") == 0 && i + 1 < argc)
      cpu = (int)parse_ul(argv[++i], "--cpu");
    else if (strcmp(argv[i], "--iters") == 0 && i + 1 < argc)
      total = parse_ul(argv[++i], "--iters");
    else if (strcmp(argv[i], "--batch") == 0 && i + 1 < argc)
      batch = parse_ul(argv[++i], "--batch");
    else if (strcmp(argv[i], "--span-mb") == 0 && i + 1 < argc)
      span_mb = parse_ul(argv[++i], "--span-mb");
    else if (strcmp(argv[i], "--span-offsets") == 0 && i + 1 < argc)
      offs_count = parse_ul(argv[++i], "--span-offsets");
    else if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) {
      i++;
      if (strcmp(argv[i], "clone") == 0)
        mode = MODE_CLONE;
      else if (strcmp(argv[i], "churn") == 0)
        mode = MODE_CHURN;
      else if (strcmp(argv[i], "churn-mem") == 0)
        mode = MODE_CHURN_MEM;
      else if (strcmp(argv[i], "rmw") == 0)
        mode = MODE_RMW;
      else
        usage(argv[0]);
    } else
      usage(argv[0]);
  }

  if (cpu >= 0) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (sched_setaffinity(0, sizeof set, &set) != 0) {
      perror("sched_setaffinity");
      return 1;
    }
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_segv;
  sa.sa_flags = SA_SIGINFO;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGSEGV, &sa, NULL) != 0) {
    perror("sigaction");
    return 1;
  }

  if (mode == MODE_CHURN)
    return run_churn(total ? total : 500000000ul, batch ? batch : 200000ul);
  if (mode == MODE_CHURN_MEM)
    return run_churn_mem(total ? total : 500000000ul, batch ? batch : 200000ul);
  if (mode == MODE_CLONE)
    return run_clone(total ? total : 2000000000ul, batch ? batch : 1000000ul);
  return run_rmw(total ? total : 500000000ul,
                 batch ? (batch < total || !total ? batch : total)
                       : 50000000ul,
                 span_mb, offs_count);
}

/* One low 4K page (bit-42 flips stay canonical-but-unmapped, matching the
 * Node captures where r13=0x6720080 lives in [heap]). */
static unsigned char *mmap_low(void) {
  unsigned char *p = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0);
  if (p == MAP_FAILED)
    p = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS,
             -1, 0);
  return p;
}

static double elapsed_sec(const struct timespec *t0,
                          const struct timespec *t1) {
  return (double)(t1->tv_sec - t0->tv_sec) +
         (double)(t1->tv_nsec - t0->tv_nsec) / 1e9;
}

/* rmw mode: hotloop (2 pages) / hotloop2 (+ TLB-pressure span). */
static int run_rmw(unsigned long total, unsigned long batch,
                   unsigned long span_mb, unsigned long offs_count) {
  if (batch > total)
    batch = total;
  unsigned char *obj_a = mmap_low();
  unsigned char *obj_b = mmap_low();
  if (obj_a == MAP_FAILED || obj_b == MAP_FAILED) {
    perror("mmap");
    return 1;
  }
  region_add("objectA", obj_a, 0x200);
  region_add("objectB", obj_b, 0x200);

  /* Initialize the verified fields. mmap already zeroed the counters. */
  memcpy(obj_a + OFF_V0, &(uint64_t){V0_INIT}, sizeof(uint64_t));
  void *ftab[1] = {(void *)&hotcallee};

  /*
   * TLB-pressure span: one RMW per iteration walks a large region in
   * shuffled page order, keeping the dTLB / page-walk path busy (the
   * corrupted bit in the Node captures sits in the PML4 index field).
   * Span contents are not verified; the hot objects still are.
   */
  struct span_args sp = {NULL, NULL, NULL};
  uint64_t *offs = NULL;
  if (span_mb > 0) {
    size_t span_len = (size_t)span_mb << 20;
    unsigned char *span =
        mmap(NULL, span_len, PROT_READ | PROT_WRITE,
             MAP_PRIVATE | MAP_ANONYMOUS | MAP_POPULATE, -1, 0);
    if (span == MAP_FAILED) {
      perror("mmap span");
      return 1;
    }
    region_add("span", span, span_len);
    size_t pages = span_len / 4096;
    if (offs_count > pages)
      offs_count = pages;
    offs = malloc(offs_count * sizeof *offs);
    if (offs == NULL) {
      perror("malloc");
      return 1;
    }
    for (size_t i = 0; i < offs_count; i++)
      offs[i] = (uint64_t)i << 12;
    /* Fisher-Yates with xorshift64*, fixed seed for reproducibility. */
    uint64_t rng = UINT64_C(0x9e3779b97f4a7c15);
    for (size_t i = offs_count - 1; i > 0; i--) {
      rng ^= rng >> 12;
      rng ^= rng << 25;
      rng ^= rng >> 27;
      size_t j = (size_t)((rng * UINT64_C(0x2545F4914F6CDD1D)) >> 32) % (i + 1);
      uint64_t tmp = offs[i];
      offs[i] = offs[j];
      offs[j] = tmp;
    }
    sp.span = span;
    sp.offs = offs;
    sp.offs_end = offs + offs_count;
  }

  fprintf(stderr,
          "repro-c: mode=rmw pid=%ld cpu=%d objA=%p objB=%p span=%p/%luMiB "
          "iters=%lu batch=%lu\n",
          (long)getpid(), sched_getcpu(), obj_a, obj_b,
          (void *)(sp.span ? sp.span : (unsigned char *)0), span_mb, total,
          batch);

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  uint64_t expect = 0;
  const unsigned memops = MEMOPS_PER_ITER + (sp.span ? 1 : 0);
  while (expect < total) {
    if (sp.span)
      hotloop2(obj_a, obj_b, ftab, batch, &sp);
    else
      hotloop(obj_a, obj_b, ftab, batch);
    expect += batch;

    /* Batch verification: catches corruption that lands on mapped pages. */
    const struct {
      unsigned off;
      uint32_t got;
    } counters[] = {
        {OFF_C0, rd32(obj_a, OFF_C0)}, {OFF_C1, rd32(obj_a, OFF_C1)},
        {OFF_C2, rd32(obj_a, OFF_C2)}, {OFF_C3, rd32(obj_a, OFF_C3)},
        {OFF_C4, rd32(obj_a, OFF_C4)}, {OFF_CB, rd32(obj_b, OFF_CB)},
    };
    for (size_t i = 0; i < sizeof counters / sizeof counters[0]; i++) {
      if (counters[i].got != (uint32_t)expect) {
        fprintf(stderr,
                "DATA MISMATCH counter +0x%x: expected=%" PRIu64
                " got=%" PRIu32 " (silent corruption, mapped page)\n",
                counters[i].off, expect, counters[i].got);
        return 43;
      }
    }
    if (rd64(obj_a, OFF_V0) != V0_INIT || rd64(obj_a, OFF_S0) != S0_PATTERN ||
        rd64(obj_a, OFF_S1) != V0_INIT) {
      fprintf(stderr,
              "DATA MISMATCH value field: v0=%016" PRIx64 " s0=%016" PRIx64
              " s1=%016" PRIx64 "\n",
              rd64(obj_a, OFF_V0), rd64(obj_a, OFF_S0), rd64(obj_a, OFF_S1));
      return 43;
    }
  }

  clock_gettime(CLOCK_MONOTONIC, &t1);
  double secs = elapsed_sec(&t0, &t1);
  fprintf(stderr,
          "PASS iters=%llu memops=%llu elapsed=%.3fs memops/s=%.0f\n",
          (unsigned long long)expect,
          (unsigned long long)expect * memops, secs,
          (double)expect * memops / secs);
  return 0;
}

/*
 * clone mode: run the liftoff-clone blob from a fresh RWX mapping, with an
 * instance page, a budget page, and a 4 GiB guard-paged linear-memory
 * reservation (first 64 KiB usable), mirroring mini-wasm.mjs under V8.
 * Each batch is one clone_entry(n) call; both the budget cell and mem[0]
 * must increment exactly n times per batch.
 */
static int run_clone(unsigned long total, unsigned long batch) {
  size_t blob = (size_t)(clone_end - clone_begin);
  void *code = mmap(NULL, 2 << 20, PROT_READ | PROT_WRITE | PROT_EXEC,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (code == MAP_FAILED) {
    perror("mmap code");
    return 1;
  }
  memcpy(code, clone_begin, blob);

  unsigned char *inst = mmap_low();
  unsigned char *budget = mmap_low();
  if (inst == MAP_FAILED || budget == MAP_FAILED) {
    perror("mmap");
    return 1;
  }
  /* [r13-0x60] stack-check word: always above rsp, so jna never fires. */
  memcpy(inst + 0xa0, &(uint64_t){UINT64_MAX}, sizeof(uint64_t));

  void *mem = mmap(NULL, UINT64_C(1) << 32, PROT_NONE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (mem == MAP_FAILED) {
    perror("mmap memory reservation");
    return 1;
  }
  if (mprotect(mem, 65536, PROT_READ | PROT_WRITE) != 0) {
    perror("mprotect memory");
    return 1;
  }
  /* [r13+0x1f] holds the linear-memory base (unaligned, as Liftoff emits). */
  memcpy(inst + 0x100 + 0x1f, &mem, sizeof mem);

  uint32_t *budget_cell = (uint32_t *)(void *)(budget + 0x100 + 0x13);
  uint32_t *mem0 = mem;

  region_add("instance", inst + 0x100 - 0x60, 0x200);
  region_add("budget", budget + 0x100, 0x200);
  region_add("memory", mem, 65536);

  fprintf(stderr,
          "repro-c: mode=clone pid=%ld cpu=%d code=%p inst=%p budget=%p "
          "mem=%p iters=%lu batch=%lu\n",
          (long)getpid(), sched_getcpu(), code, inst, budget, mem, total,
          batch);

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  uint64_t expect = 0;
  while (expect < total) {
    uint32_t n = (uint32_t)(batch < total - expect ? batch : total - expect);
    uint32_t got = clone_entry(code, inst, budget + 0x100, n);
    expect += n;
    if (got != (uint32_t)expect || *budget_cell != (uint32_t)expect ||
        *mem0 != (uint32_t)expect) {
      fprintf(stderr,
              "DATA MISMATCH: expected=%" PRIu64 " entry-ret=%" PRIu32
              " budget=%" PRIu32 " mem0=%" PRIu32
              " (silent corruption, mapped page)\n",
              expect, got, *budget_cell, *mem0);
      return 43;
    }
  }

  clock_gettime(CLOCK_MONOTONIC, &t1);
  double secs = elapsed_sec(&t0, &t1);
  fprintf(stderr, "PASS iters=%llu elapsed=%.3fs iters/s=%.0f\n",
          (unsigned long long)expect, secs, (double)expect / secs);
  return 0;
}

/*
 * churn mode: per round, set up a fresh code mapping (RW), write the
 * liftoff-clone blob into it (with a fresh round number patched into the
 * code bytes, as V8 never emits the same code twice), flip it RX, make a
 * fresh instance page and budget page, execute, verify, and retire the
 * round's mappings to a reaper thread that unmaps them asynchronously —
 * the alloc/free concurrency V8's background code-GC provides.
 *
 * The 4 GiB guard-paged memory reservation is process-lifetime, unlike
 * V8's per-instance reservation: the first churn version reserved one per
 * round and a process wedged unkillably inside exit_mmap during teardown
 * (see README). Keeping it stable avoids that VMA-teardown pattern while
 * retaining the compile/execute churn that mini-wasm-churn.mjs showed to
 * be the essential trigger (15/15 SIGSEGV under load where the
 * steady-state probes score ~1%/run).
 */
struct retire {
  void *ptr;
  size_t len;
};
static pthread_mutex_t retire_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t retire_cv = PTHREAD_COND_INITIALIZER;
static struct retire retire_q[128];
static int retire_head, retire_tail, retire_done;

static void *reaper_main(void *unused) {
  (void)unused;
  for (;;) {
    pthread_mutex_lock(&retire_mu);
    while (retire_head == retire_tail && !retire_done)
      pthread_cond_wait(&retire_cv, &retire_mu);
    if (retire_head == retire_tail && retire_done) {
      pthread_mutex_unlock(&retire_mu);
      return NULL;
    }
    struct retire r = retire_q[retire_tail];
    retire_tail = (retire_tail + 1) % 128;
    pthread_mutex_unlock(&retire_mu);
    munmap(r.ptr, r.len);
  }
}

static void retire_push(void *ptr, size_t len) {
  pthread_mutex_lock(&retire_mu);
  int next = (retire_head + 1) % 128;
  if (next == retire_tail) { /* full: reap inline (backpressure) */
    pthread_mutex_unlock(&retire_mu);
    munmap(ptr, len);
    return;
  }
  retire_q[retire_head].ptr = ptr;
  retire_q[retire_head].len = len;
  retire_head = next;
  pthread_cond_signal(&retire_cv);
  pthread_mutex_unlock(&retire_mu);
}

static int run_churn(unsigned long total, unsigned long batch) {
  size_t blob = (size_t)(clone_end - clone_begin);
  size_t imm_off = (size_t)(spin_imm - clone_begin);

  void *mem = mmap(NULL, UINT64_C(1) << 32, PROT_NONE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (mem == MAP_FAILED) {
    perror("mmap memory reservation");
    return 1;
  }
  if (mprotect(mem, 65536, PROT_READ | PROT_WRITE) != 0) {
    perror("mprotect memory");
    return 1;
  }
  uint32_t *mem0 = mem;

  pthread_t reaper;
  if (pthread_create(&reaper, NULL, reaper_main, NULL) != 0) {
    perror("pthread_create");
    return 1;
  }

  fprintf(stderr, "repro-c: mode=churn pid=%ld cpu=%d mem=%p iters=%lu batch=%lu\n",
          (long)getpid(), sched_getcpu(), mem, total, batch);

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  uint64_t expect = 0;
  uint64_t rounds = 0;
  while (expect < total) {
    uint32_t n = (uint32_t)(batch < total - expect ? batch : total - expect);

    void *code = mmap(NULL, 256 << 10, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    unsigned char *inst = mmap_low();
    unsigned char *budget = mmap_low();
    if (code == MAP_FAILED || inst == MAP_FAILED || budget == MAP_FAILED) {
      perror("mmap");
      return 1;
    }
    memcpy(code, clone_begin, blob);
    /* Fresh code bytes per round: r12 is dead in the clone, so the
     * per-round value is inert to execution but new to the memory system. */
    memcpy((char *)code + imm_off, &rounds, sizeof(uint32_t));
    if (mprotect(code, 256 << 10, PROT_READ | PROT_EXEC) != 0) {
      perror("mprotect code");
      return 1;
    }
    memcpy(inst + 0xa0, &(uint64_t){UINT64_MAX}, sizeof(uint64_t));
    memcpy(inst + 0x100 + 0x1f, &mem, sizeof mem);

    /* Handler verdicts refer to the current round's regions. */
    g_nregions = 0;
    region_add("instance", inst + 0x100 - 0x60, 0x200);
    region_add("budget", budget + 0x100, 0x200);
    region_add("memory", mem, 65536);

    uint32_t got = clone_entry(code, inst, budget + 0x100, n);
    expect += n;
    rounds++;

    uint32_t budget_cell = *(uint32_t *)(void *)(budget + 0x100 + 0x13);
    if (got != (uint32_t)expect || budget_cell != n ||
        *mem0 != (uint32_t)expect) {
      fprintf(stderr,
              "DATA MISMATCH round=%" PRIu64 ": n=%" PRIu32
              " entry-ret=%" PRIu32 " budget=%" PRIu32 " mem0=%" PRIu32
              " expected-mem0=%" PRIu64 " (silent corruption, mapped page)\n",
              rounds, n, got, budget_cell, *mem0, expect);
      return 43;
    }

    retire_push(code, 256 << 10);
    retire_push(inst, 4096);
    retire_push(budget, 4096);
  }

  pthread_mutex_lock(&retire_mu);
  retire_done = 1;
  pthread_cond_signal(&retire_cv);
  pthread_mutex_unlock(&retire_mu);
  pthread_join(reaper, NULL);
  munmap(mem, UINT64_C(1) << 32);

  clock_gettime(CLOCK_MONOTONIC, &t1);
  double secs = elapsed_sec(&t0, &t1);
  fprintf(stderr, "PASS rounds=%llu iters=%llu elapsed=%.3fs rounds/s=%.0f\n",
          (unsigned long long)rounds, (unsigned long long)expect, secs,
          (double)rounds / secs);
  return 0;
}

/*
 * churn-mem mode: the original, syscall-heaviest churn variant — per
 * round a fresh 4 GiB guard-paged reservation plus code/instance/budget
 * mappings, all torn down inline (4 mmap + 2 mprotect + 4 munmap per
 * round, single-threaded). On 7.1.8-1-cachyos, ~75 loaded runs of this
 * shape produced two kernel oopses on CPU 19 (mprotect syscall entry,
 * CR2 = kernel stack address + 2^42) and wedged one process unkillably in
 * exit_mmap. Retained as a separate mode because it is the only native
 * workload so far that manifested the fault (in kernel mode) — and
 * because it can wedge the machine. See README "Native trigger attempts".
 */
static int run_churn_mem(unsigned long total, unsigned long batch) {
  size_t blob = (size_t)(clone_end - clone_begin);
  uint64_t expect = 0;
  uint64_t rounds = 0;

  fprintf(stderr,
          "repro-c: mode=churn-mem pid=%ld cpu=%d iters=%lu batch=%lu\n",
          (long)getpid(), sched_getcpu(), total, batch);

  struct timespec t0, t1;
  clock_gettime(CLOCK_MONOTONIC, &t0);

  while (expect < total) {
    uint32_t n = (uint32_t)(batch < total - expect ? batch : total - expect);

    void *code = mmap(NULL, 256 << 10, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    unsigned char *inst = mmap_low();
    unsigned char *budget = mmap_low();
    void *mem = mmap(NULL, UINT64_C(1) << 32, PROT_NONE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    if (code == MAP_FAILED || inst == MAP_FAILED || budget == MAP_FAILED ||
        mem == MAP_FAILED) {
      perror("mmap");
      return 1;
    }
    memcpy(code, clone_begin, blob);
    memcpy((char *)code + (size_t)(spin_imm - clone_begin), &rounds,
           sizeof(uint32_t));
    if (mprotect(code, 256 << 10, PROT_READ | PROT_EXEC) != 0) {
      perror("mprotect code");
      return 1;
    }
    memcpy(inst + 0xa0, &(uint64_t){UINT64_MAX}, sizeof(uint64_t));
    if (mprotect(mem, 65536, PROT_READ | PROT_WRITE) != 0) {
      perror("mprotect memory");
      return 1;
    }
    memcpy(inst + 0x100 + 0x1f, &mem, sizeof mem);

    g_nregions = 0;
    region_add("instance", inst + 0x100 - 0x60, 0x200);
    region_add("budget", budget + 0x100, 0x200);
    region_add("memory", mem, 65536);
    region_add("code", code, blob);

    uint32_t got = clone_entry(code, inst, budget + 0x100, n);
    expect += n;
    rounds++;

    uint32_t budget_cell = *(uint32_t *)(void *)(budget + 0x100 + 0x13);
    uint32_t mem0 = *(uint32_t *)mem;
    if (got != n || budget_cell != n || mem0 != n) {
      fprintf(stderr,
              "DATA MISMATCH round=%" PRIu64 ": n=%" PRIu32
              " entry-ret=%" PRIu32 " budget=%" PRIu32 " mem0=%" PRIu32
              " (silent corruption, mapped page)\n",
              rounds, n, got, budget_cell, mem0);
      return 43;
    }

    munmap(code, 256 << 10);
    munmap(inst, 4096);
    munmap(budget, 4096);
    munmap(mem, UINT64_C(1) << 32);
  }

  clock_gettime(CLOCK_MONOTONIC, &t1);
  double secs = elapsed_sec(&t0, &t1);
  fprintf(stderr, "PASS rounds=%llu iters=%llu elapsed=%.3fs rounds/s=%.0f\n",
          (unsigned long long)rounds, (unsigned long long)expect, secs,
          (double)rounds / secs);
  return 0;
}
