# Workload catalog

Fault Affinity selects every live workload explicitly. The initial public
catalog exposes only the exact-CPU capability; the legacy diagnostic scripts
remain separate until their other phases use the generic owner.

```sh
node fault-affinity.mjs workloads
node fault-affinity.mjs inspect --workload wasm-churn
```

## Built-ins

- `wasm-churn` is the recommended dependency-free reduced trigger. Each
  attempt is a bounded survival window around `mini-wasm-churn.mjs`.
- `node-pglite` is the historical heavyweight trigger. It keeps
  `child.mjs`, `package.json`, and `package-lock.json` in provenance and requires
  the installed PGlite dependency at execution time.

Neither built-in runs while listing, inspecting, or planning.

The catalog entries are defined in `catalog.mjs`. They bind exact executable,
argument, lifecycle, outcome, capability, and provenance identities; they are
not shell command templates.

## Custom workload files

A custom file is a JSON workload-contract version 1 object. Relative
`command.executable`, `command.cwd`, and `provenance.files` paths resolve from
the JSON file's directory. The JSON file is automatically added to provenance.

The initial resumable CLI rejects `environment.pass`, because an ambient value
cannot be reproduced safely across resume without separate private binding-key
state. Explicit `environment.set` values are supported and bound to the exact
JSON file. Custom workloads are trusted local programs, not sandboxed code.
They must not daemonize or leave the supervised process group.

Example finite workload:

```json
{
  "version": 1,
  "id": "my-trigger",
  "label": "My trigger",
  "description": "One bounded invocation of my local trigger.",
  "risk": "standard",
  "command": {
    "executable": "/absolute/path/to/my-trigger",
    "args": [],
    "cwd": "."
  },
  "environment": {},
  "attempt": {
    "mode": "exit",
    "timeoutMs": 10000,
    "termGraceMs": 1000,
    "killGraceMs": 1000
  },
  "outcomes": {
    "targetSignals": ["SIGSEGV"],
    "mappedExits": []
  },
  "capabilities": {
    "isolated": true
  },
  "provenance": {
    "completeness": "complete",
    "files": []
  }
}
```

Scripts should name their interpreter as `command.executable` and place the
script path in `command.args` and `provenance.files`. Command strings are never
evaluated through a shell.
