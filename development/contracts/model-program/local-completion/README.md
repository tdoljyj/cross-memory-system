# Local completion preparation

These two private library components prepare the original model program's
bounded local development invocation. They do not provide a public CLI, issue a
Profile, qualify a Host, register a provider or publish a model.

`scripts/model-program/local_completion_execution.py` accepts an exact plan and
the trusted Host caller's existing boundary. That boundary independently checks
the current authorization, Binding/subject/scope, revocation, qualified source
and installed caller. Its consume phase atomically reserves one attempt before
dispatch. An arbitrary Python callback is not an authority proof. Source tests
use callbacks as fixtures only; a passing test does not supply the live boundary.
That installed integration and a fresh exact experiment permission are still
external inputs. No old M1/T0/T1 window or consumed Profile is reopened.

The plan fixes executable, model, prompt, output schema, the runtime file closure
and a caller-verified tokenization observation tied to that exact prompt. The
primitive verifies file bytes/SHA before consumption; the Host must freeze the
verified file namespace/ACL through launch and qualify the DLL loading boundary.
Local hashes alone cannot prove that isolation. Windows execution uses the
direct local `llama-completion.exe`, never the server-client `llama-cli`.
Checks bracket each file operation and hash block. A filesystem operation that
returns late causes rejection before consumption/launch; this library cannot
cancel a blocked filesystem syscall or qualify its latency. The Host must also
qualify the local I/O boundary. UNC/network paths are refused.
The before/after stop checks also cannot interrupt a blocking OS spawn or
cleanup syscall. The wrapper does not claim a universal absolute return-time
guarantee for such failures; late operations never permit resume/consumption,
and unverified cleanup remains a failure with retained diagnostics.
Only the fixed CPU arguments are constructed: two threads, no GPU layers,
device `none`, no operation/KV offload, no context shifting, no conversation,
no warmup, finite prediction, no prompt display and simple IO. No extra argv,
server URL, model download, interactive input or API credential is forwarded.

The local ceilings are 4096 input tokens, 512 generated tokens, 4608 total tokens,
120 seconds including a 13-second owned-cleanup reserve, and at most 1MiB on each
output stream. They are allocation ceilings, not approved experiment budgets.
The actual fresh Profile may be tighter. Context size is not an input-token
counter: the exact tokenizer observation is required before consumption, and
the configured boundary must verify its provenance. The fixed prediction cap
and input observation must fit the total ceiling. This wrapper does not run a
tokenizer or invent an observed count.

Windows starts the owned child suspended, assigns it to a kill-on-close Job,
then resumes it. Deadlines, lost admission, read failure and output overflow stop
only that Job. Job accounting must show zero active processes; failure is
`CLEANUP_UNVERIFIED`. Assignment failure kills the still-suspended owned parent.
The private POSIX transport is exercised only by non-model source fixtures;
the public model primitive rejects non-Windows platforms and does not claim
POSIX descendant quiescence. Boundary calls are bounded by the same stop time.
A timed-out consume reply means reservation status is unknown: no launch or
retry, and the caller must settle it through its original boundary. It must not
release a live uncancellable external action as completed.

Original stdout/stderr are retained. An output overflow retains a bounded prefix
and explicitly reports failure; it is not represented as a complete response.
Per-stream capture completeness, truncation and observed-chunk counts survive
cleanup errors. Hashes describe retained bytes, not an unknowable complete
stream. Cleanup failure does not erase the primary execution outcome.
Process exit zero and successful cleanup do not establish valid model output or
measured usage. `completion_saved_response.py` optionally parses the exact
b11033 output framing and preserves framing bytes separately. It accepts usage
only from caller-verified machine-readable observations; absent fields remain
absent. It does not infer token usage from budgets, perf text, sampling counts,
historical bench numbers or fixture data. Exact source pins establish local
format compatibility, not current installation or authority.

The response adapter returns an intermediate carrier. The existing v2
request/result/attempt producer and `invocation_saved_projection.py` own their
schemas, status selection and saved-slot semantics. These components create no
v2 result/attempt, model candidate acceptance, Gold, M2 verdict, quality winner,
qualification, release or activation. C1/C2/C3 and the full M0–M7 goal remain
unchanged; this is one ingredient of actual execution, not model completion.
