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
    siAddrSource: null,
    cr2: null,
    cr2Source: null,
    cr2Note: null,
    threadCount: 0,
    processId: null,
    mappings: [],
    mappingsComplete: false,
    classification: "no-fault",
    knownInstruction: false,
    intendedAddr: null,
    intendedMapped: null,
    intendedWritable: null,
    siAddrMapped: null,
    addrDiff: null,
    addrDiffHex: null,
    diffBits: [],
    matchesKnownArithmetic: false,
    matchesKnownSignature: false,
    notes: [],
  };

  let inMappings = false;
  let mappingHeaderSeen = false;
  let mappingCollectionClosed = false;
  let mappingTableValid = true;
  let lastMappingEnd = null;
  let mappingIssueNoted = false;
  let sawInstruction = false;
  const explicitSiAddrSeen = lines.some((line) => /^SI_ADDR=/.test(line));

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
      sawInstruction = true;
      continue;
    }

    // Explicit label printed by the improved capture-fault.sh.
    m = line.match(/^SI_ADDR=(0x[0-9a-fA-F]+|\(nil\))\s*$/);
    if (m) {
      if (out.siAddrSource === null) {
        out.siAddrSource = m[1] === "(nil)" ? "explicit-nil" : "explicit";
        out.siAddr = m[1] === "(nil)" ? null : m[1].toLowerCase();
      } else {
        out.notes.push("duplicate SI_ADDR label ignored (first occurrence kept)");
      }
      continue;
    }

    m = line.match(/^CR2=(0x[0-9a-fA-F]+|\(nil\))\s*$/);
    if (m) {
      out.cr2Source = m[1] === "(nil)" ? "explicit-nil" : "explicit";
      out.cr2 = m[1] === "(nil)" ? null : m[1].toLowerCase();
      continue;
    }

    // Backward compatibility for the original capture script, which printed
    // si_addr as GDB's first convenience variable. This source is ambiguous
    // with other `p` commands, so it is retained for arithmetic/manual review
    // but can never confirm the known signature.
    m = line.match(/^\$1 = (0x[0-9a-fA-F]+)\s*$/);
    if (m && !explicitSiAddrSeen && sawInstruction && !inMappings && out.siAddrSource === null) {
      out.siAddr = m[1].toLowerCase();
      out.siAddrSource = "legacy-convenience";
      continue;
    }

    m = line.match(/^[\s*]*\d+\s+Thread 0x[0-9a-f]+ \(LWP (\d+)\) "(.*?)"/);
    if (m) {
      out.threadCount += 1;
      continue;
    }

    if (line === "MAPPINGS_COMPLETE=1") {
      if (inMappings && mappingHeaderSeen && mappingTableValid) {
        out.mappingsComplete = true;
      } else {
        out.notes.push(
          inMappings && mappingHeaderSeen
            ? "mapping-completion marker followed an invalid or unrecognized mapping row"
            : "mapping-completion marker appeared outside a mapping table",
        );
      }
      inMappings = false;
      mappingCollectionClosed = true;
      continue;
    }
    if (!mappingCollectionClosed && !inMappings && /^Mapped address spaces:/.test(line)) {
      inMappings = true;
      mappingHeaderSeen = false;
      mappingTableValid = true;
      lastMappingEnd = null;
      mappingIssueNoted = false;
      continue;
    }
    if (inMappings) {
      if (!mappingHeaderSeen) {
        if (
          /^\s*Start Addr\s+End Addr\s+Size\s+Offset\s+Perms(?:\s+(?:File|[Oo]bjfile))?\s*$/.test(
            line,
          )
        ) {
          mappingHeaderSeen = true;
        } else if (line.trim() !== "") {
          mappingTableValid = false;
          if (!mappingIssueNoted) {
            out.notes.push("mapping table contains content before its expected header");
            mappingIssueNoted = true;
          }
        }
        continue;
      }
      m = line.match(
        /^(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+([r-][w-][x-][ps])\s*(.*)$/,
      );
      if (m) {
        const start = BigInt(m[1]);
        const end = BigInt(m[2]);
        const size = BigInt(m[3]);
        if (
          end <= start ||
          size !== end - start ||
          (lastMappingEnd !== null && start < lastMappingEnd)
        ) {
          mappingTableValid = false;
          if (!mappingIssueNoted) {
            out.notes.push("mapping table contains invalid bounds, size, order, or overlap");
            mappingIssueNoted = true;
          }
        } else {
          out.mappings.push({
            start: m[1],
            end: m[2],
            perms: m[5],
            file: m[6].trim(),
          });
          lastMappingEnd = end;
        }
      } else if (line.trim() !== "") {
        mappingTableValid = false;
        if (!mappingIssueNoted) {
          out.notes.push("mapping table contains an unrecognized nonblank row");
          mappingIssueNoted = true;
        }
      }
      continue;
    }
  }

  if (out.cr2Source === null) {
    out.cr2Note = "CR2 was not explicitly available in this transcript";
  } else if (out.cr2Source === "explicit-nil") {
    out.cr2Note = "CR2 was explicitly reported as unavailable";
  }

  if (!out.captured) {
    out.notes.push("no SIGSEGV stop found in transcript");
    return out;
  }
  out.classification = "manual";

  // A parsed mapping proves membership even in a truncated table. Absence only
  // proves an address is unmapped when GDB reached the command immediately
  // following `info proc mappings` and emitted its completion marker.
  const hasMappings = out.mappings.length > 0;
  const findMapping = (addrBig) =>
    out.mappings.find(
      (mp) => BigInt(mp.start) <= addrBig && addrBig < BigInt(mp.end),
    );

  if (out.siAddr !== null) {
    const si = BigInt(out.siAddr);
    out.siAddrMapped = findMapping(si) ? true : out.mappingsComplete ? false : null;
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
      out.intendedMapped = intendedMap ? true : out.mappingsComplete ? false : null;
      out.intendedWritable = intendedMap
        ? intendedMap.perms.includes("w")
        : out.mappingsComplete
          ? false
          : null;
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
          out.matchesKnownArithmetic = true;
          // The confirmed signature requires a valid intended write target
          // and evidence that the +2^42 fault address is outside every
          // parsed mapping. Arithmetic alone is not enough.
          if (
            out.intendedMapped === true &&
            out.intendedWritable === true &&
            out.siAddrMapped === false &&
            out.siAddrSource === "explicit"
          ) {
            out.matchesKnownSignature = true;
            out.classification = "known-signature";
          } else {
            out.classification = "bit-flip-unverified";
            const reason = !out.mappingsComplete && !hasMappings
              ? "no complete mapping data in transcript; address validity is unknown"
              : out.intendedMapped === false
                ? "intended address not found in process mappings"
                : out.intendedWritable === false
                  ? "intended mapping is not writable"
                  : out.siAddrMapped === true
                    ? "shifted fault address is itself mapped"
                    : out.siAddrMapped !== false
                      ? "mapping table did not complete; shifted fault address mapping state is unknown"
                      : "fault address came from an ambiguous legacy GDB convenience variable";
            out.notes.push(
              `si_addr matches the +2^42 single-bit-42 arithmetic, but the mapping preconditions are not verified: ${reason}`,
            );
          }
        } else {
          out.notes.push(
            `si_addr differs from intended address by ${out.addrDiffHex} (bits ${out.diffBits.join(",")}), not the documented +2^42 signature`,
          );
        }
      } else {
        out.notes.push(
          out.siAddrSource === "explicit-nil"
            ? "si_addr was explicitly reported as nil"
            : "si_addr not found in transcript",
        );
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
