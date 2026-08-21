# Understand bounded generic debugger attempt I/O

The internal debugger-attempt I/O layer captures synthetic byte streams today.
It does not start GDB, run a workload, create phase state, or add a public
command.

## Keep two exact channels

One channel contains the combined human-readable debugger and workload
transcript. Its 64 MiB limit comes from the debugger phase manifest. A distinct
channel contains canonical control records and uses the control protocol's
64 KiB limit. The collector rejects one shared input object because the two
streams must never compete for the same iterator.

The transcript is written to a private parent-side regular file and unlinked
immediately. Its open descriptor remains the only handle. The target therefore
does not receive a scratch path or a retained bundle-directory descriptor.
Control bytes remain in bounded memory.

## Drain without extending the evidence bound

Both channels run concurrently. At the bound, the collector stops retaining
new bytes but continues reading and hashing accepted chunks until the input
ends. This gives later process supervision a complete drain witness without
allowing retained evidence to grow past its manifest limit.

Each channel reports:

- protocol or transcript version and byte limit;
- `complete`, `overflow`, `stream-error`, `storage-error`, or `invalid` status;
- a stable error code when status is not complete;
- total observed byte count and SHA-256 digest;
- retained byte count; and
- whether the bound was exceeded.

When a channel's stream never finishes draining and its storage also fails,
the status is `stream-error`: an incomplete drain invalidates the observed
byte accounting itself and is never hidden behind a storage failure.
`storage-error` is reserved for fully drained streams whose retained bytes are
suspect. The precedence lives in a single status-ordering function; a
synthetic regression test would require injecting faults into the private
spool and memory channels, which the module deliberately does not expose.

The attempt-level I/O result is complete only when the transcript is complete
and the entire control stream is both complete and valid. A debugger-generated
`profile-error` sequence is still valid control evidence; it describes a
debugger outcome rather than an I/O failure.

## Keep retained bytes process-local

The returned capture handle reads the anonymous transcript in bounded chunks
and returns copies of the control bytes. Disposing the handle closes the final
transcript descriptor and prevents further access. A future complete-only
store must consume the handle before disposal and must not publish overflowed,
partial, or invalid input as a complete attempt.

The [supervised adapter](generic-debugger-adapter.md) now connects the two
channels to a real debugger launch: the adapter forwards the combined
transcript and the private control descriptor through the established Node
supervisor into this layer. The remaining execution work is to combine
process cleanup, control, and transcript facts in a typed complete-only
attempt envelope and durable artifacts.
