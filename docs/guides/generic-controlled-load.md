# Run a generic controlled-load comparison

Use `fault-affinity controlled-load` to compare one measured workload before,
during, and after a separately declared condition workload. The command creates
a schema-3 manifest-version-5 bundle and publishes only one complete A1/B/A2
session.

The measured workload may be a built-in ID or a trusted custom workload file.
The condition is currently a trusted custom workload file and must declare
`survive-window` lifecycle semantics. Fault Affinity starts one condition
process per worker CPU, verifies each process identity and singleton affinity,
and stops the complete set after B. Neither workload may daemonize or escape
its supervised process group.

## Write the plan

Create a bounded JSON file such as `controlled-load-plan.json`:

```json
{
  "version": 1,
  "controlledLoad": {
    "targetCpu": 19,
    "workerCpus": "0-7",
    "attemptsPerLeg": 10,
    "warmupMs": 5000,
    "recoveryMs": 5000
  },
  "exact": {
    "cpus": "18-21",
    "rounds": 10,
    "seed": 17
  }
}
```

CPU lists must be canonical ascending strings. `targetCpu` must not appear in
`workerCpus`. The exact schedule is bound at bundle creation so it can be run
later without changing the evidence identity.

The condition workload's observation window must be long enough to remain
active through warm-up and every B attempt. Planned stop still cancels it as
soon as the B boundary is complete.

## Validate without execution

```sh
node fault-affinity.mjs controlled-load \
  --workload-file workloads/measured.json \
  --condition-workload-file workloads/condition.json \
  --plan-file controlled-load-plan.json \
  --out-dir diagnostics/controlled-load \
  --dry-run
```

The dry run resolves both workload identities, validates capabilities and
lifecycles, checks the plan against the host CPU allowance, and prints the
bound schedules. It does not create a bundle or start either workload.

## Run and resume the session

After reviewing the dry run, replace `--dry-run` with `--yes`. If the run is
interrupted or any leg or condition witness is invalid, no partial session is
published. Resume repeats the complete A1/B/A2 unit:

```sh
node fault-affinity.mjs controlled-load \
  --resume diagnostics/controlled-load \
  --workload-file workloads/measured.json \
  --condition-workload-file workloads/condition.json \
  --yes
```

A completed controlled-load resume is a validated no-op. Resume requires the
same two workload files because manifest version 5 binds both launch
identities.

## Run the bound exact phase

The exact phase is a separate sibling in the same bundle:

```sh
node fault-affinity.mjs exact \
  --resume diagnostics/controlled-load \
  --workload-file workloads/measured.json \
  --condition-workload-file workloads/condition.json \
  --yes
```

Supplying `--condition-workload-file` to `exact` is valid only for resume. It
allows the version-5 bundle reader to verify the auxiliary identity; the
condition workload is not started during exact attempts.

## Interpret the boundary

The published session supports comparison of observed outcomes across A1, B,
and A2 under the declared condition. It does not by itself identify a causal
mechanism or infer CPU topology. Preserve the plan, both workload contracts,
and the complete bundle when sharing results.

The historical [`load-state-aba.mjs`](controlled-load-experiments.md) modes
remain available for the original investigation. They include multi-executable
and debugger experiments that do not share this single-measured-workload
schema.
