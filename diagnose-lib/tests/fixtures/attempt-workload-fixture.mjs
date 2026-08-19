import { spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

function identity(pid = process.pid) {
  const line = readFileSync(`/proc/${pid}/stat`, "utf8").trimEnd();
  const close = line.lastIndexOf(") ");
  const fields = line.slice(close + 2).split(/\s+/);
  return {
    pid,
    state: fields[0],
    processGroupId: Number(fields[2]),
    sessionId: Number(fields[3]),
    startTicks: fields[19],
  };
}

function writeFd(fd, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function writeJson(value) {
  writeFd(1, `${JSON.stringify(value)}\n`);
}

function hold() {
  writeJson({ type: "ready", identity: identity() });
  setInterval(() => {}, 1_000);
}

function descendant(resistant) {
  if (resistant) process.on("SIGTERM", () => {});
  process.send?.({ type: "ready", identity: identity() });
  writeJson({ type: "descendant", identity: identity() });
  setInterval(() => {}, 1_000);
}

function spawnDescendant(resistant) {
  return spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant", resistant ? "1" : "0"], {
    detached: false,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

async function tree({ leaderExits }) {
  if (!leaderExits) process.on("SIGTERM", () => {});
  const child = spawnDescendant(true);
  const ready = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(
      new Error(`descendant exited before ready: code=${code} signal=${signal}`),
    ));
  });
  child.disconnect();
  const record = {
    type: leaderExits ? "leader-exits" : "tree-ready",
    identity: identity(),
    descendant: ready.identity,
  };
  if (leaderExits) {
    child.unref();
    writeJson(record);
    process.exit(0);
  }
  writeJson(record);
  setInterval(() => {}, 1_000);
}

function flood(byteCount) {
  writeFd(1, Buffer.alloc(byteCount, 0x61));
  writeFd(2, Buffer.alloc(byteCount, 0x62));
}

const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "exact":
    writeJson({
      type: "exact",
      args,
      cwd: process.cwd(),
      environment: Object.fromEntries(Object.keys(process.env).sort().map((name) =>
        [name, process.env[name]])),
      identity: identity(),
    });
    break;
  case "exit":
    writeFd(1, args[1] ?? "");
    writeFd(2, args[2] ?? "");
    process.exit(Number(args[0]));
    break;
  case "self-signal":
    process.kill(process.pid, args[0] ?? "SIGUSR2");
    break;
  case "hold":
    hold();
    break;
  case "tree":
    await tree({ leaderExits: false });
    break;
  case "leader-exits-with-holder":
    await tree({ leaderExits: true });
    break;
  case "descendant":
    descendant(args[0] === "1");
    break;
  case "flood":
    flood(Number(args[0]));
    break;
  default:
    throw new Error(`unknown attempt fixture mode: ${mode}`);
}
