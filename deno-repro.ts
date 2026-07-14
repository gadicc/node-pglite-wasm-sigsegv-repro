const childCount = Number.parseInt(Deno.args[0] ?? "16", 10);
const repetitions = Number.parseInt(Deno.args[1] ?? "20", 10);
const childV8Flags = Deno.env.get("CHILD_V8_FLAGS");

console.log(
  `deno=${Deno.version.deno} v8=${Deno.version.v8} children=${childCount} waves=${repetitions} v8Flags=${childV8Flags ?? "default"}`,
);

async function runChild(index: number) {
  const args = [
    "run",
    ...(childV8Flags ? [`--v8-flags=${childV8Flags}`] : []),
    "-A",
    "--node-modules-dir=manual",
    "child.mjs",
  ];
  const command = new Deno.Command(Deno.execPath(), {
    args,
    cwd: new URL(".", import.meta.url),
    stdout: "null",
    stderr: "piped",
  });
  const result = await command.output();

  return {
    code: result.code,
    index,
    signal: result.signal,
    stderr: new TextDecoder().decode(result.stderr),
  };
}

let failedWaves = 0;

for (let wave = 1; wave <= repetitions; wave += 1) {
  const results = await Promise.all(
    Array.from({ length: childCount }, (_, index) => runChild(index + 1)),
  );
  const failures = results.filter(
    ({ code, signal }) => code !== 0 || signal !== null,
  );

  if (failures.length > 0) failedWaves += 1;
  console.log(
    `wave=${wave} passed=${childCount - failures.length}/${childCount}`,
  );
  for (const failure of failures) {
    console.log(
      `child=${failure.index} code=${failure.code} signal=${failure.signal}`,
    );
    if (failure.stderr) console.log(failure.stderr.trim());
  }
  if (failures.length > 0 && Deno.env.get("STOP_ON_FAILURE") === "1") break;
}

console.log(`failedWaves=${failedWaves}/${repetitions}`);
if (failedWaves > 0) Deno.exitCode = 1;
