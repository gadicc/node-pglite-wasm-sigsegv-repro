# Understand internal pinned-concurrent waves

The pinned-concurrent phase models one topology context as a correlated wave.
Every context declares an active CPU set and a distinct controller CPU. The
outer bundle owner coordinates the wave from that controller while one
independently supervised workload child runs on each active CPU.

## Bind placement to the schedule

The immutable phase manifest records:

- One workload ID, contract version, digest, and `pinnedConcurrent` capability
- A fresh phase generation
- Named contexts with kind, cluster label, active CPUs, and controller CPU
- Singleton controller and child execution modes
- The absolute `taskset` path
- A seeded schedule that balances context order and each context's child launch
  order across rounds

The controller CPU must be outside its context's active set. Changing topology,
rounds, seed, execution mode, or workload identity invalidates resume.

## Witness the controller and every child

Before launching a wave, the phase adapter reads the bundle owner's allowed CPU
list and requires it to contain exactly the scheduled controller CPU. Each
attempt then records that its stable supervisor and direct workload were both
restricted to exactly the scheduled child CPU.

The wave envelope binds those placement witnesses to the schedule slot and one
canonical [attempt record](attempt-records.md) per child. A complete envelope
therefore states where the controller ran, where every child ran, and how every
attempt ended and cleaned up.

## Publish only complete waves

A controller mismatch launches no children. A runner or operational child
failure cancels active peers. Neither case advances the schedule. Only a wave
whose children all have valid outcomes, complete cleanup, and matching
singleton witnesses may be published.

The internal store uses this layout inside its caller-owned private directory:

| Path | Meaning |
| --- | --- |
| `pinned-concurrent-phase.json` | Exclusive canonical phase manifest |
| `pinned-concurrent-wave-NNNNNNNNN.json` | One exclusive canonical complete-wave envelope |

Readers require an exact contiguous prefix, bounded private files, and a clean
known inventory. They may reconcile a known dead writer, but reject a live
writer, gap, changed manifest, or foreign entry.

Schema-3 manifest version 4 binds this store at
`state/pinned-concurrent/` alongside baseline, group, and exact-CPU state. The
bundle lease covers selection, execution, cleanup, and commit, and remains held
by active supervisors if the outer owner is interrupted. No current
`diagnose.sh` phase or legacy bundle writes this format.

See [ADR 0014](../decisions/0014-pinned-concurrent-and-manifest-v4.md) for the
accepted compatibility boundary.
