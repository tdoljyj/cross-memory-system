# Observed completion to saved v2 records

This Source preparation connects the separately pinned e567 observed runtime to
the existing v2 result/attempt producer and saved projector. It performs no model,
tokenizer, process, file, network, store or permission operation. Neither generated
candidate records nor pure fixture tests establish actual usage, qualification,
stage completion, a fresh experiment Profile or Host acceptance.

`build_completion_records` retains the original b11033 binding and format rules.
`build_observed_completion_records` selects the new adapter explicitly, sharing
the existing request, attempt, lifecycle, deadline, product-schema and v2 checks.
There is no public arbitrary-adapter argument or mutation of the old pins.

The new call accepts `token_record_raw`, `expected_limits`, and the independently
verified machine bytes through `observation_raw` / `observation_validator`.
The adapter binds all nine built runtime members, the Source patch and unchanged
sampling/log sources, plan and prompt hashes, stream hashes, stop, captures and
process cleanup. Callbacks remain the caller's independently trusted boundary;
returning fixture facts or matching local hashes creates no such trust.

The sidecar supplies normalized input-token and returned-sample counts. Returned
EOG counts as an output sample even though it has no displayed piece. Only a
consistent normal terminal together with verified settled process, complete
captures, cleanup and the matching declared stop supplies complete token usage.
Stdout removes exactly the EOG marker plus three bound newlines, or two bound
newlines for predict. No trimming, log scraping, JSON repair or legacy DLL/codec
reinterpretation occurs.

External accounting must explicitly provide costs, currency identity, input and
output byte counts and elapsed duration. Missing values remain unknown. Input
bytes mean the bound provider-prompt raw bytes; output bytes mean complete raw
stdout including Source framing. These accounting boundaries require caller
adoption and are separate from the request's original input digest. Sidecar uptime
ticks are neither UTC timestamps nor observed process duration.

The producer binds the sidecar hash into the independently verified lifecycle
context, retains the original sidecar even on refusal, and rejects contradictory
capture/cleanup facts. Success still needs explicit eligible lifecycle outcome,
product-schema verification, actual accounting, timely complete output and v2
schema checks. A settled failure with complete actual facts can retain a failure
record and real usage without a payload; an overrun requires an explicit mapped
budget error and is never clipped to the budget. Partial or unverified observations
retain raw evidence and gaps, never unknown-to-zero success.

This integration does not supply the live currentness/revocation/atomic-consume
implementation, fresh development experiment/data permission, isolated Host/DLL
namespace or final three-workflow Gold/threshold bindings. Those remain concrete
prerequisites before any real model call; old exhausted experiments and VM remain
terminal.
