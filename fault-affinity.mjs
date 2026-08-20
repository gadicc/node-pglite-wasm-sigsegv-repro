#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runFaultAffinityCli } from "./src/fault-affinity/cli.mjs";

export {
  FaultAffinityCliError,
  parseFaultAffinityArgs,
  runFaultAffinityCli,
} from "./src/fault-affinity/cli.mjs";

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runFaultAffinityCli(process.argv.slice(2));
}
