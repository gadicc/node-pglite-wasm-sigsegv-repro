// Harmless finite fixture emulating the fixed GDB command profile surface for
// generic debugger-adapter tests. It never debugs anything: it decodes the
// embedded profile config from its own argv, writes a synthetic transcript to
// stdout and stderr, echoes the target argv it received after --args, and
// emits a mode-selected control sequence to fd 3. The mode arrives through
// the target workload environment (FAKE_DEBUGGER_MODE), which is exactly the
// environment the adapter applies to its debugger child.
import { writeSync } from "node:fs";

import { canonicalProtocolJson } from "../../pinned-protocol.mjs";

const mode = process.env.FAKE_DEBUGGER_MODE ?? "exited";

function writeFd(fd, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function configFromArgv(argv) {
  const prefix = "--eval-command=python exec(";
  const argument = argv.find((entry) => entry.startsWith(prefix) && entry.endsWith(")"));
  if (argument === undefined) {
    throw new Error("fake debugger: embedded profile argument missing");
  }
  const source = JSON.parse(argument.slice(prefix.length, -1));
  const match = source.match(
    /^CONFIG = json\.loads\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\.decode\("utf-8"\)\)$/m,
  );
  if (match === null) throw new Error("fake debugger: embedded profile config missing");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

const config = configFromArgv(process.argv.slice(2));
const argsSplit = process.argv.slice(2).indexOf("--args");
const targetArgv = argsSplit === -1 ? [] : process.argv.slice(2).slice(argsSplit + 1);

let sequence = 0;
function emit(type, extra = {}) {
  sequence += 1;
  writeFd(3, `${canonicalProtocolJson({
    version: 1,
    type,
    generation: config.generation,
    manifestSha256: config.manifestSha256,
    run: config.run,
    nonce: config.nonce,
    sequence,
    ...extra,
  })}\n`);
}

writeFd(1, `FAKE_DEBUGGER_STDOUT\t${mode}\n`);
writeFd(2, `FAKE_DEBUGGER_STDERR\t${mode}\n`);
writeFd(1, `FAKE_DEBUGGER_TARGET_ARGV\t${JSON.stringify(targetArgv)}\n`);
writeFd(1, `FAKE_DEBUGGER_ENV\t${process.env.FAKE_DEBUGGER_PASS_VALUE ?? "-"}\n`);

switch (mode) {
  case "exited":
    emit("profile-ready", { profileId: config.profileId });
    emit("inferior-started", {
      pid: process.pid,
      startTicks: "987654",
      allowedCpuList: config.allowedCpuList,
    });
    emit("inferior-exited", { exitCode: 0 });
    emit("profile-complete");
    break;
  case "stopped":
    emit("profile-ready", { profileId: config.profileId });
    emit("inferior-started", {
      pid: process.pid,
      startTicks: "987654",
      allowedCpuList: config.allowedCpuList,
    });
    emit("inferior-stopped", { signal: "SIGSEGV" });
    emit("capture-complete", { sections: config.captureSections });
    emit("profile-complete");
    break;
  case "signaled":
    emit("profile-ready", { profileId: config.profileId });
    emit("inferior-started", {
      pid: process.pid,
      startTicks: "987654",
      allowedCpuList: config.allowedCpuList,
    });
    emit("inferior-signaled", { signal: "SIGUSR2" });
    emit("profile-complete");
    break;
  case "launch-error":
    emit("profile-ready", { profileId: config.profileId });
    emit("profile-error", { stage: "launch", code: "GDB_LAUNCH_ERROR" });
    emit("profile-complete");
    break;
  case "silent":
    break;
  case "garbage-control":
    writeFd(3, "this is not a canonical control record\n");
    break;
  default:
    throw new Error(`unknown fake debugger mode: ${mode}`);
}
