# Understand controlled-load phase storage

The controlled-load store publishes an A1/B/A2 comparison only after the
entire session validates. It deliberately has no partial-session resume format.

## Store files

| File | Meaning |
| --- | --- |
| `controlled-load-phase.json` | Immutable canonical measured/auxiliary session manifest |
| `controlled-load-session.json` | One immutable canonical complete-session envelope |

An initialized store without the session file is empty, even if an earlier
execution produced operational logs elsewhere. The next owner repeats a fresh
whole session. Once the session file exists and validates, the phase is
complete and another run is a no-op.

Both files use exclusive private mode, canonical one-line JSON, bounded size,
and durable no-clobber publication. Known dead-writer temporary files can be
reconciled; a live writer, foreign entry, unsafe file type, manifest mismatch,
or second publication fails closed.

## Schema-3 manifest version 5

Manifest version 5 is the controlled-load variant. It contains:

- The complete measured workload and digest binding
- The complete auxiliary workload and digest binding
- A composed `controlledLoad: supported` phase control
- The bound [controlled-load session manifest](controlled-load-aba-sessions.md)
- `state/controlled-load/` and `state/exact-cpu/` ownership

Version 5 is not a superset of version 4. It does not contain baseline, group,
or pinned-concurrent phase state. Versions 1 through 4 preserve their existing
keys and directories. A future combined variant needs another manifest version.

Readers and owners receive both resolved workloads. This is necessary because
the persisted public workload records intentionally do not contain private
launch environment values.

## One complete transaction

The bundle owner holds one exclusive descriptor-backed lease while it:

1. Confirms that the phase store is empty.
2. Runs the complete A1/B/A2 session.
3. Waits for every measured and managed supervisor cleanup.
4. Publishes the complete session envelope without clobbering.
5. Rereads and validates the new complete bundle state.

Other readers and phase owners cannot enter during that interval. If the outer
owner is interrupted, inherited supervisor descriptors retain the lease until
bounded cleanup ends; direct workloads receive no bundle descriptor.

The public [`fault-affinity controlled-load`](../guides/generic-controlled-load.md)
command initializes and advances this variant. Its sibling `exact` resume also
requires the auxiliary workload identity to validate the manifest, but does not
start condition workers. The historical controlled-load script and
multi-workload evidence remain separate.

See [ADR 0018](../decisions/0018-controlled-load-store-and-manifest-v5.md) for
the accepted storage and ownership boundary.
