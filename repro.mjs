import { fork } from "node:child_process";

const childCount = Number.parseInt(process.argv[2] ?? "16", 10);
const repetitions = Number.parseInt(process.argv[3] ?? "50", 10);
const stopOnFailure = process.env.STOP_ON_FAILURE !== "0";

console.log(
  `node=${process.version} v8=${process.versions.v8} platform=${process.platform} arch=${process.arch} children=${childCount} waves=${repetitions}`,
);

function runChild(index) {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const child = fork(new URL("./child.mjs", import.meta.url), [], {
      execPath: process.execPath,
      silent: true,
    });
    let stderr = "";
    let launchError;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      launchError = error;
    });
    child.once("close", (code, signal) => {
      resolve({
        code,
        elapsedMs: Math.round(performance.now() - startedAt),
        index,
        launchError,
        signal,
        stderr,
      });
    });
  });
}

let failedWaves = 0;
let completedWaves = 0;

for (let wave = 1; wave <= repetitions; wave += 1) {
  const results = await Promise.all(
    Array.from({ length: childCount }, (_, index) => runChild(index + 1)),
  );
  const failures = results.filter(
    ({ code, signal }) => code !== 0 || signal !== null,
  );
  completedWaves = wave;

  if (failures.length > 0) failedWaves += 1;
  console.log(
    `wave=${wave} passed=${childCount - failures.length}/${childCount}`,
  );

  for (const failure of failures) {
    console.log(
      `child=${failure.index} code=${failure.code} signal=${failure.signal} elapsedMs=${failure.elapsedMs}`,
    );
    if (failure.launchError) console.log(failure.launchError.stack);
    if (failure.stderr) console.log(failure.stderr.trim());
  }

  if (failures.length > 0 && stopOnFailure) break;
}

console.log(
  `failedWaves=${failedWaves} completedWaves=${completedWaves} requestedWaves=${repetitions}`,
);
process.exitCode = failedWaves > 0 ? 1 : 0;
