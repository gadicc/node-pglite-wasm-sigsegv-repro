import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

export const PLAN_FILE_MAX_BYTES = 1024 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class PlanFileError extends Error {
  constructor(message, code = "PLAN_FILE_IO_ERROR") {
    super(message);
    this.name = "PlanFileError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new PlanFileError(message, code);
}

function stablePlanBytes(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || filename.includes("\0") ||
      Buffer.byteLength(filename) > 16 * 1024) {
    fail("--plan-file must be a bounded absolute NUL-free path");
  }
  let fd;
  try {
    const before = lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.size <= 0n ||
        before.size > BigInt(PLAN_FILE_MAX_BYTES) || before.nlink !== 1n) {
      fail(`--plan-file must be a nonempty singly-linked regular file no larger than ${PLAN_FILE_MAX_BYTES} bytes`);
    }
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino ||
        before.size !== opened.size || before.mtimeNs !== opened.mtimeNs ||
        before.ctimeNs !== opened.ctimeNs || opened.nlink !== 1n) {
      fail("--plan-file changed while it was opened", "PLAN_FILE_CHANGED");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (opened.dev !== after.dev || opened.ino !== after.ino ||
        opened.size !== after.size || opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs || bytes.length !== Number(opened.size)) {
      fail("--plan-file changed while it was read", "PLAN_FILE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PlanFileError) throw error;
    fail(`--plan-file could not be read safely: ${error?.code ?? "unknown error"}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readPlanJsonFile(filename) {
  const bytes = stablePlanBytes(filename);
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail("--plan-file must contain valid UTF-8", "PLAN_FILE_CONTENT_ERROR");
  }
  if (text.includes("\0") || text.includes("\r")) {
    fail("--plan-file contains a forbidden control byte", "PLAN_FILE_CONTENT_ERROR");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("--plan-file must contain valid JSON", "PLAN_FILE_CONTENT_ERROR");
  }
}
