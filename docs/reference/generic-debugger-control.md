# Understand the generic debugger control protocol

The internal debugger control protocol is a small machine-readable evidence
stream for a future generic GDB runner. It validates synthetic records today;
it does not start GDB, run a workload, create phase state, or add a public
command.

## Keep control separate from diagnostic output

GDB and the inferior may produce large, presentation-oriented stdout and
stderr transcripts. Those bytes are valuable for later inspection, but they
are not a stable source for lifecycle decisions.

The control stream is separately limited to 64 KiB and eight canonical JSON
records. Each record repeats the phase generation, canonical manifest digest,
scheduled run, per-attempt nonce, and contiguous sequence number. This prevents
records from another phase or attempt from being accepted as the current run.

## Require one complete state sequence

The valid paths are:

```text
profile-ready
  -> profile-error(launch) -> profile-complete
  -> inferior-started
       -> profile-error(observe) -> profile-complete
       -> inferior-exited        -> profile-complete
       -> inferior-signaled      -> profile-complete
       -> inferior-stopped
            -> capture-complete  -> profile-complete
            -> profile-error(capture) -> profile-complete
```

`inferior-started` records PID, `/proc` start ticks, and the witnessed allowed
CPU list. The CPU list must be exactly the manifest's singleton CPU. A complete
capture must name the manifest's full fixed section list in order.

The parser rejects missing or extra records, sequence gaps, misplaced error
stages, unknown fields or signals, changed bindings, affinity drift,
noncanonical JSON, invalid UTF-8, forbidden control bytes, missing final
newlines, and bound violations.

## Preserve independent evidence

The parsed result keeps four facts separate:

- the stable inferior identity and affinity witness, when launch succeeded;
- the workload terminal event, when one was observed;
- the complete capture-section witness, when capture succeeded; and
- a structured operational error, when launch, observation, or capture failed.

For example, a stopped signal followed by a capture error retains the stopped
signal and separately records the capture error. Later outcome classification
can therefore report what happened without claiming that a complete transcript
was captured.

The complete raw control bytes receive their own SHA-256 digest, byte count,
and record count. A future envelope can bind those bytes without reparsing
human-readable debugger output.

## Remaining execution boundary

The [bounded attempt-I/O layer](generic-debugger-attempt-io.md) now retains the
control bytes separately from an anonymous, size-capped transcript while fully
draining both inputs, the [materialized command profile](generic-debugger-phase.md)
embeds a fixed Python profile that emits this protocol to a control descriptor
kept non-inheritable from the inferior, and the [supervised adapter](generic-debugger-adapter.md)
routes that descriptor separately from the combined transcript. Synthetic
tests run the profile's gdb-free emission prelude under `python3` and validate
the bytes with the real parser, and runner tests route a fake debugger's
records through the full supervision stack. The remaining work is to combine
adapter lifecycle, cleanup, control, and transcript facts into a complete-only
attempt envelope. Until that exists, the control protocol is an internal
contract exercised only by synthetic tests.
