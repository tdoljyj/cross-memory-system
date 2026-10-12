# Saved decision candidate projection

`decision_candidate_projection.project_decision_snapshot` connects the existing
complete saved v2 carrier to the three existing workflow scorers. It performs no
I/O, model/tokenizer invocation, action, issuer or Canonical write. Local argument
dictionaries are projections, not new Port objects, registered TaskSpecs or
domain adoption. The full original M0–M7 and C1/C2/C3 obligations remain active.

The caller supplies the original snapshot, one exact input binding for every
registered request, an adopted payload Schema's original bytes/digest, pre-frozen
runtime/scorer status maps and existing task policy. The caller independently
verifies lawful inputs, saved-carrier provenance, exact Source, domain adoption,
current authority and reference provenance. A matching hash or provided list is
not proof. The old extraction Schema must not be replaced by an unadopted draft.
The binding's `output_schema_digest` comes from the verified original request
and must match that Schema under the existing canonical-JSON Port convention.

Caller configuration/identity errors refuse the batch before judging predictions;
the caller's original bytes remain untouched. Per-candidate parsing/schema/ref
failures preserve raw bytes/hash, actual provider status and supplied usage, and
become the explicitly mapped invalid status. Missing probability-contract facts
remain unknown. No category keys or missing costs/time/tokens/Gold are defaulted.
Every expected request, including runtime failures, unknowns and semantic
abstentions, stays in the denominator.

Semantic abstention in a successfully delivered schema-valid payload maps to the
caller-bound abstention category while retaining the succeeded provider status
and raw payload. Runtime timeout/failure never becomes model-informed abstention.
The decision's local status fragment remains separate from Port `result.outcome`.

Relation payloads echo the fixed input pair and may cite only visible evidence.
The existing relation scorer checks bound labels, actual caller reference support
and required counterevidence. Ranking payloads partition the same permitted
Context set without repeats; the existing scorer checks cutoff/token budget and
external relevance/downstream evidence. Raw ranking numbers do not become
probabilities. A route candidate selects a code-supplied route reference; its path
and actions are derived from the caller's catalogue and graph, then checked by
the existing route scorer. Models cannot supply or invent executable actions.

Probability distributions require an explicit estimation-object/label/tolerance
binding and finite, complete keys and sums. A model's calibration reference is
retained as a claim with `calibration_provenance_verified=false`. This library
admits no probability automatic path; actual calibration evaluation and its
domain/currentness qualifications remain separate. Semantic correctness also
remains separate from structure/membership and requires lawful external truth.

Neither a scorer report nor this projection issues a Profile, Provider
qualification, DomainAuthority, DataGate, model selection, activation or M7
completion. Fresh experiment/input-use authority and the actual supported fixed
runner/currentness/revocation/one-attempt consumer remain necessary before real
execution. Old consumed experiments and VM permissions remain terminal.
