// parse-gdb.mjs - analyze a capture-fault.sh transcript.
//
// Extracts the pristine SIGSEGV context (RIP, registers, faulting
// instruction, si_addr, threads, mappings) and, for the small set of
// *exact* previously documented faulting instructions, computes the
// architecturally intended effective address and compares it with the
// kernel-reported fault address.
//
// This is deliberately NOT a general x86 parser: unknown instructions are
// preserved verbatim and flagged for manual classification.
//
// Usage: node parse-gdb.mjs <capture-file>

import { readFileSync } from "node:fs";

// Exact-match table of documented faulting instructions (normalized:
// single spaces, no address prefix). Each entry yields the base register
// and displacement needed to compute the intended linear address.
const KNOWN_INSTRUCTIONS = [
  {
    pattern: /^addl \$0x1,0x1c0\(%r13\)$/,
    base: "r13",
    displacement: 0x1c0n,
    canonical: "addl $1, 0x1c0(%r13)",
  },
  {
    pattern: /^mov %rbp,0xb0\(%r13\)$/,
    base: "r13",
    displacement: 0xb0n,
    canonical: "mov %rbp, 0xb0(%r13)",
  },
];

const BIT42 = 1n << 42n;

function normalizeInstruction(text) {
  return text.trim().replace(/\s+/g, " ");
}

export function parseGdbCapture(text) {
  const lines = text.split("\n");
  const out = {
    captured: false,
    rip: null,
    instructionRaw: null,
    instruction: null,
    registers: {},
    siAddr: null,
    cr2: null,
    cr2Note: "not exposed by ptrace/gdb on Linux x86-64; si_addr is equivalent",
    threadCount: 0,
    processId: null,
    mappings: [],
    classification: "no-fault",
    knownInstruction: false,
    intendedAddr: null,
    intendedMapped: null,
    intendedWritable: null,
    siAddrMapped: null,
    addrDiff: null,
    addrDiffHex: null,
    diffBits: [],
    matchesKnownSignature: false,
    notes: [],
  };

  let inMappings = false;
  let mappingHeaderSeen = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/received signal SIGSEGV/.test(line)) {
      out.captured = true;
      // The faulting frame address is printed on the following line.
      const next = lines[i + 1] ?? "";
      const m = next.match(/^(0x[0-9a-f]+)\s+in\s/);
      if (m) out.rip = m[1];
      continue;
    }

    let m = line.match(/^process (\d+)\s*$/);
    if (m) {
      out.processId = Number(m[1]);
      continue;
    }

    // Register dump lines: "r13            0x6720080           108134528"
    m = line.match(
      /^(rax|rbx|rcx|rdx|rsi|rdi|rbp|rsp|r8|r9|r10|r11|r12|r13|r14|r15|rip|eflags)\s+(0x[0-9a-f]+)\s/,
    );
    if (m) {
      out.registers[m[1]] = m[2];
      if (m[1] === "rip" && out.rip === null) out.rip = m[2];
      continue;
    }

    // Faulting instruction line from "x/2i $pc": "=> 0xADDR:\tINSTR"
    m = line.match(/^=>\s+0x[0-9a-f]+:\s*(.+)$/);
    if (m) {
      out.instructionRaw = m[1].trim();
      out.instruction = normalizeInstruction(m[1]);
      continue;
    }

    // Explicit label printed by the improved capture-fault.sh.
    m = line.match(/^SI_ADDR=(0x[0-9a-f]+)\s*$/);
    if (m) {
      out.siAddr = m[1];
      continue;
    }

    // Backward compatible: first convenience variable holding an address
    // (the original capture-fault.sh printed si_addr as $1).
    m = line.match(/^\$\d+ = (0x[0-9a-f]+)\s*$/);
    if (m && out.siAddr === null) {
      out.siAddr = m[1];
      continue;
    }

    m = line.match(/^[\s*]*\d+\s+Thread 0x[0-9a-f]+ \(LWP (\d+)\) "(.*?)"/);
    if (m) {
      out.threadCount += 1;
      continue;
    }

    if (/^Mapped address spaces:/.test(line)) {
      inMappings = true;
      mappingHeaderSeen = false;
      continue;
    }
    if (inMappings) {
      if (!mappingHeaderSeen) {
        if (/Start Addr/.test(line)) mappingHeaderSeen = true;
        continue;
      }
      m = line.match(
        /^(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+([rwxps-]{4,5})\s*(.*)$/,
      );
      if (m) {
        out.mappings.push({
          start: m[1],
          end: m[2],
          perms: m[5],
          file: m[6].trim(),
        });
      }
      continue;
    }
  }

  if (!out.captured) {
    out.notes.push("no SIGSEGV stop found in transcript");
    return out;
  }
  out.classification = "manual";

  // Locate si_addr relative to mappings.
  const findMapping = (addrBig) =>
    out.mappings.find(
      (mp) => BigInt(mp.start) <= addrBig && addrBig < BigInt(mp.end),
    );

  if (out.siAddr !== null) {
    const si = BigInt(out.siAddr);
    const siMap = findMapping(si);
    out.siAddrMapped = Boolean(siMap);
  }

  // Intended address for the exact known instructions only.
  if (out.instruction !== null) {
    for (const known of KNOWN_INSTRUCTIONS) {
      if (!known.pattern.test(out.instruction)) continue;
      out.knownInstruction = true;
      const baseHex = out.registers[known.base];
      if (baseHex === undefined) {
        out.notes.push(`base register ${known.base} missing from dump`);
        break;
      }
      const intended = BigInt(baseHex) + known.displacement;
      out.intendedAddr = `0x${intended.toString(16)}`;
      const intendedMap = findMapping(intended);
      out.intendedMapped = Boolean(intendedMap);
      out.intendedWritable = intendedMap
        ? intendedMap.perms.includes("w")
        : false;
      if (intendedMap) out.intendedMappingFile = intendedMap.file;

      if (out.siAddr !== null) {
        const si = BigInt(out.siAddr);
        const diff = si - intended;
        out.addrDiff = diff.toString();
        out.addrDiffHex = `0x${diff.toString(16)}`;
        const xor = si ^ intended;
        for (let bit = 0n; xor >> bit > 0n; bit += 1n) {
          if ((xor >> bit) & 1n) out.diffBits.push(Number(bit));
        }
        if (diff === BIT42 && out.diffBits.length === 1 && out.diffBits[0] === 42) {
          out.matchesKnownSignature = true;
          out.classification = "known-signature";
        } else {
          out.notes.push(
            `si_addr differs from intended address by ${out.addrDiffHex} (bits ${out.diffBits.join(",")}), not the documented +2^42 signature`,
          );
        }
      } else {
        out.notes.push("si_addr not found in transcript");
      }
      break;
    }
    if (!out.knownInstruction) {
      out.notes.push(
        "faulting instruction is not in the exact known-instruction table; evidence preserved for manual classification",
      );
    }
  } else {
    out.notes.push("faulting instruction not found in transcript");
  }

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node parse-gdb.mjs <capture-file>");
    process.exit(2);
  }
  console.log(JSON.stringify(parseGdbCapture(readFileSync(file, "utf8")), null, 2));
}
