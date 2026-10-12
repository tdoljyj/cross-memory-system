# Saved workflow scorer preparation

`workflow_saved_scorers.py` prepares task-specific numeric and structural
comparisons for the three logical tasks in the adopted full model plan:

- `score_semantic_relations(records, policy)` compares caller-bound relation
  labels, permitted/supporting references, retained counterevidence and external
  reference labels. It does not decide the truth of a relationship by model
  self-report or by the old extraction-count scorer.
- `score_context_relevance(records, policy)` evaluates a ranking of the same
  caller-fixed permitted Context candidates. It checks IDs, duplicate ranking,
  caller token costs/budget and explicit gain/cutoff/discount policy. Actual
  external relevance labels are needed for NDCG; downstream outcomes are
  separate caller observations. Raw ranking scores are not probabilities.
- `score_processing_routes(records, policy)` checks paths and actions against
  the caller's existing legal graph, action set, terminal nodes, step/budget
  limits and external permitted routes/loss mapping. It never invokes actions.
  Policy action costs are planned route costs, not measured runtime charges.

These are private pure Python functions, not new formal Capability IDs,
TaskSpecs, product Schemas, label registries, policy adoption or Gate issuers.
The three `decision.*` names are the plan's logical task keys. Formal domain
identity, taxonomy or relevance scale, reference/Gold provenance, compatible
Schema and current permission must be resolved through the actual existing
domain process. The caller owns their validation. A string reference or local
hash alone supplies no authority.

Policies explicitly supply expected request IDs, the local status-category
mapping, task-specific labels/graph/ranking rules and optional formal reference
fields. Local status keys are not registered protocol statuses. No default
relation labelspace, relevance grade scale, action IDs, threshold values,
probability calibration, sample-size acceptance or Gold is invented here.
The policy must be frozen before evaluation; callback/config changes do not
silently inherit an earlier accepted subject.

All expected requests stay in the report denominator, including failures,
abstentions and unknown statuses. Missing references or external labels stay
unknown; missing correctness/NDCG/downstream results do not become zero or a
passing score. Candidate fields that claim their own correctness or probability
do not create truth or calibrated probability. Structural checks, reference
support, semantic comparisons, abstention, runtime failures and model quality
remain separate. Actual latency, token use and charged cost remain external
observations; source fixtures and policy costs are not model measurements.
Definite structural/reference violations remain invalid even when another
policy is absent. Missing policy alone remains unassessed; it is not evidence
that a candidate is correct or incorrect. Context IDCG is the caller-frozen
unconstrained ranking baseline over the whole candidate set. It does not solve
budget-constrained optimal selection or prove the minimum sufficient Context.

The reports carry no authority or qualification. Existing metrics arithmetic
and later accepted task-specific bindings can use these components, but no
formal M2 verdict, model selection, release or activation follows from a local
score. Neither a fixture nor an author-visible development item is unseen Gold.
No model, network, process, filesystem, Canonical write or data generation is
performed by the functions.

This Source work belongs to the original Task1502 and the full M0–M7 goal.
C1/mobile, C2/standard and C3/flagship each retain their complete qualification,
activation and M7 obligations. Real evaluation still needs a fresh exact
experiment permission and supported trusted caller; old consumed/expired
experiments and VM windows are not reopened.
