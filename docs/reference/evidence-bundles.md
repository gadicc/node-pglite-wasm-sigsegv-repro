# Understand diagnostic evidence bundles

This reference describes the current `diagnose.sh` bundle layout, integrity token, privacy review, resume behavior, and versioned phase envelopes. Use it before publishing, resuming, or repeating evidence.

## Inspect the output layout

The runner creates `diagnostics/UTC_timestamp/` unless you set `--out-dir`.

| Path | Purpose |
| --- | --- |
| `report.md` | Human-readable report derived from the current validated evidence |
| `results.json` | Machine-readable derived results |
| `commands.log` | Shell-quoted command log with known local prefixes replaced |
| `run.log` | Progress log with known local prefixes replaced |
| `env/` | Sanitized unprivileged system information |
| `env/root/` | Optional validated privileged reads |
| `logs/` | Raw phase output |
| `freq/` | Frequency samples for baseline and group phases |
| `telemetry/` | Timestamped per-CPU frequency, temperature, and turbo-state samples |
| `results/individual.*` | Immutable isolated schedule, outcomes, boundaries, and metadata |
| `results/pinned-concurrent.*` | Topology contexts, immutable launch plan, waves, and exact child boundaries |
| `gdb/` | Generation-bound live debugger transcripts |
| `results/gdb.manifest` | Authoritative GDB envelope with exact runner, metadata, and transcript digests |
| `results/gdb.meta` | Legacy descriptive GDB summary |
| `privacy-review.txt` | Category and file-level sentinel scan for sensitive-looking values |
| `manifest.txt` | File names and SHA-256 digests for the completed bundle generation |
| `state/` | Phase completion, resume, transaction, and superseded-generation state |

Telemetry envelopes bind to the exact owning workload generation. Group telemetry binds its metadata, tabular samples, and every canonical outcome log. Exact-CPU phases also bind their per-child boundary sidecar.

## Verify the readiness token

`manifest.txt` is the bundle's sole readiness token. Treat `report.md`, `results.json`, and `privacy-review.txt` as one authoritative generation only when the manifest exists and verifies.

Run this command from inside the bundle:

```sh
sha256sum -c manifest.txt
```

Every real run or resume revokes the token before it changes evidence or derived output. An interruption can leave useful files behind an absent manifest. Those files do not form a completed generation.

Resume the bundle to validate finalization candidates and regenerate the authoritative set:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z --yes
```

## Review privacy before publication

Preflight excludes known service tags, serial numbers, UUIDs, Media Access Control (MAC) addresses, and BIOS passwords. Kernel command-line collection uses an allowlist for CPU and frequency parameters. Journal excerpts use message-only output without timestamp or hostname prefixes.

Raw GNU Debugger (GDB), mappings, and third-party output can still contain local paths or unexpected identifiers. `privacy-review.txt` reports categories and files that need inspection. A flag does not mean the file is unsafe.

Before sharing a bundle:

1. Verify `manifest.txt`.
2. Review `privacy-review.txt`.
3. Inspect every raw file it flags.
4. Archive the complete bundle, not `report.md` alone.
5. Send the archive through an appropriate secure channel.
6. Provide service tags separately through the support case.

The complete directory lets a reviewer connect conclusions to machine-readable results, logs, telemetry, and phase manifests.

## Resume completed phases

Phase markers live under `state/`. Resume validates completed phases before skipping them. Partial per-CPU tables can continue with only missing observations.

A run interrupted during fresh initialization is resumable when the directory contains only recognized initialization artifacts. Resume discards those artifacts and starts fresh instead of treating the directory as a completed bundle.

Use:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z --yes
```

Do not edit phase evidence by hand before resume. Validation fails closed and preserves unrecognized data for review.

## Repeat a phase with `--redo`

Use `--redo` when you need a fresh contiguous sample instead of topping up missing observations:

```sh
./diagnose.sh --resume diagnostics/2026-08-01T084335Z \
  --redo individual --individual-runs 50 --yes
```

The runner moves previous evidence to `state/superseded/`; it does not delete it. The archive records the earlier generation and prevents accidental pooling.

Redoing preflight invalidates and repeats its complete downstream closure:

- Baseline
- Groups
- Individual
- Pinned concurrent
- Frequency
- GDB

The archive includes the fixed environment snapshot and `env/root/`. Privileged reads from an older preflight generation cannot remain current after a preflight redo.

## Validate preflight evidence

Preflight uses a fixed artifact inventory, per-file SHA-256 manifest, generation identifier, strict summary schema, and zero-byte completion marker.

Resume revalidates completed preflight evidence. Partial or modified files remain preserved and require `--redo preflight`.

## Validate baseline evidence

Baseline uses a fixed metadata and log envelope bound to the stored child count, wave count, process status, and completion marker.

Missing, malformed, mismatched, or unsafe file types remain preserved. Resume requires `--redo baseline` instead of overwriting or using them for conclusions.

## Bind group and individual generations

`results/groups.meta` assigns a fresh random generation to every group attempt. `results/individual.meta` records the exact group generation that authorized its CPU targets.

Redoing groups creates a new generation even when it discovers the same topology plan. Older individual evidence then fails validation and requires `--redo individual`.

Legacy envelopes without generation binding remain descriptive. They cannot authorize current conclusions.

Individual protocols version 1 through version 5 retain their original meanings. Version 6 changed liveness and statistics by accepting securely launched non-`SIGSEGV` workload failures as committed descriptive observations.

An incomplete version-5 attempt in a schema-2 bundle requires `--redo individual`. The runner archives its plan, state, and telemetry sessions together. Completed baseline and group evidence can remain current when their dependencies still validate.

## Bind pinned-concurrent evidence

Pinned-concurrent version 2 records exact signals, non-target workload failures, operational failures, and bounded stderr provenance.

A resumed version-1 checkpoint can remain as a disclosed contiguous legacy prefix. The runner preserves its original `0` and `139` classifications without inventing missing signal or stderr detail.

## Bind GDB evidence

GDB capture attempts do not combine across resumes. Before starting a new attempt or publishing a terminal skip, the runner archives any incomplete metadata, transcripts, runner log, manifests, and stale derived output in one transaction.

The next resume recovers an interrupted archive transaction before phase execution. Empty setup directories do not count as evidence.

A completed GDB phase is current only when the generation-bound manifest validates. Older marker-plus-`gdb.meta` bundles remain descriptive and require `--redo gdb` for authoritative capture evidence.

## Publish privileged read evidence

`root-checks.sh` collects into a private root-owned staging directory. An unprivileged helper validates and publishes an allowlisted payload set with strict digest metadata.

The publisher invalidates `manifest.txt` before changing the bundle. It also removes stale privacy review, results, and report files. A zero-byte completion marker is published last.

An interrupted attempt follows these rules:

- A fully handed-off orphan can be republished after validation
- `--fresh` discards a recognized orphan and collects again
- Root's recognized half-staged leftovers can be cleared and restaged
- Unrecognized state is refused for manual inspection

After publication, resume `diagnose.sh` to derive and sign a new bundle generation.

## Publish frequency evidence

`frequency-ab.sh` stages evidence privately until system settings are restored and verified. Its publisher can retain complete or partial evidence after a handled interruption.

Before replacing frequency evidence, it removes the prior completion marker. Resume validates the new files before publishing a current marker and final bundle manifest.

The root-owned restore ledger remains outside the user-owned diagnostics bundle under `/run/node-pglite-wasm-sigsegv-repro/`. Do not rename, copy into a bundle, or manually edit that recovery state.

## Treat legacy bundles conservatively

Evidence schema and phase-protocol versions encode meaning, not cosmetic structure. Do not infer newer fields or semantics for older bundles.

The current readers follow these principles:

- Preserve original outcome meanings
- Keep legacy evidence descriptive when it lacks a required binding
- Require explicit redo for incomplete protocols whose liveness rules changed
- Never overwrite a mismatched or malformed envelope silently
- Keep superseded generations separate from current results

Future generic-workload schemas must extend these rules. Existing Node/PGlite bundles should never be upgraded in place.
