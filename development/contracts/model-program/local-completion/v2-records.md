# Completion observations to existing v2 records

`completion_v2_records.py` prepares the next part of the original model program's
saved-result chain. It accepts original completion bytes, the existing fixed
format binding, an already bound request/index, and caller-verified observations.
It has no file, network, process, tokenizer, model, authority, registration or
persistence operation. Its returned bytes are candidate records for the existing
`invocation_saved_projection.py`, not Canonical writes or model qualification.

```python
prepared = build_completion_records(
    stdout_raw, stderr_raw, format_binding, index, record_fields,
    schema_bundle=schema_bundle, port_digest=existing_port_digest,
    observation_raw=observation_raw,
    observation_validator=trusted_observation_validator,
    lifecycle_validator=trusted_lifecycle_validator,
    output_validator=bound_product_schema_validator,
)
```

The caller supplies the unchanged schema bytes and its existing digest convention.
`record_fields` contains exactly `result_fields`, `attempt_fields` and `capture`;
the module exports their local field sets. The lifecycle validator checks a copied
context binding the request/index, attempt, capture and machine-observation digest,
then returns `verified_context` with the same facts and an explicit
`outcome_consistent` boolean, including the caller's failure mapping. This return
shape still proves no live authority by itself. The output validator separately
checks the candidate and exact request, returning the already bound validation
status. The function returns original evidence and `gaps` on an incomplete chain.
Only populated `result_raw` and `attempt_raw` can be passed as complete candidate
records; the outer trusted caller still owns persistence and actual admission.

The producer preserves stdout, stderr, machine observation and payload bytes.
It uses the unchanged request/result/attempt v2 schemas and their existing byte
pins. Request identity and configuration flow into both records; supplied result
and attempt metadata must agree with that binding. It does not mint reservation,
settlement, lifecycle, permission, provider qualification or currentness receipts.
An arbitrary callback or a supplied reference is not evidence of live authority.
The installed trusted caller must separately authenticate and freeze those sources.

Exit zero and parseable JSON do not select `succeeded`. Success requires explicit
caller-verified lifecycle facts, complete original stream captures and verified
owned cleanup, a valid output under the separately supplied product schema, and
all required measured usage. Unknown or contradictory observations cannot create
a complete success record. Failures and missing inputs keep their original bytes
and explicit gaps. Missing counts, costs, times and references are never filled
with zero, budgets or estimates. The existing result schema requires all eight
usage fields; incomplete usage therefore cannot produce complete result bytes.
Capture read-error fields use the process primitive's actual booleans. Timing
tolerance is an explicit caller-frozen local input, not a default clock allowance.
Observed budget overruns remain real counts in a verified failure; they never
become eligible success or get clipped down to the budget.

Token counts must come from the exact runtime's real machine observations. A
prediction cap, context size, printed text, runtime perf diagnostics or re-tokenized
output is not automatically the count of the original generated tokens. Capture
byte counts describe the exact boundary observed, including truncation. Caller
semantics must define and authenticate any provider payload boundary separately
from stdout framing and the original Segment input digest.

The same request's deadlines, lease, attempt identity, currency/profile and budget
bounds remain applicable. A late, cancelled, failed or unverified-cleanup result
cannot become acceptance eligible through local conversion. Parsing, output schema
validation, provider-call outcome, candidate acceptance and business acceptance
remain separate decisions. The helper adopts no new terminal status taxonomy.

Source tests use old public specification examples and hypothetical non-model
observations only. Passing them does not issue a fresh experiment Profile, qualify
an installed Host, measure a model, produce Gold or complete an M0–M7 stage. The
full C1/C2/C3 obligations remain active. Actual model execution still needs a fresh
precise permission and the qualified currentness/revocation/one-attempt caller;
old experiments and VM permissions stay terminal.

