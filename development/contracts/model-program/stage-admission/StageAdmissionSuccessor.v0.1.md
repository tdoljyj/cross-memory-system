# Model stage admission successor v0.1

This short engineering successor implements the direction adopted in original Task `1502fd80-8ff8-4adc-b4f5-da6d462f4f8a` v290, Decision `07696647-1557-4b0d-9eed-c1f698f4b011` v1. It grants no execution, data access or model qualification. The machine contract is [StageAdmissionSuccessor.v0.1.json](StageAdmissionSuccessor.v0.1.json); accepted service authority and current admissions remain controlling.

The unchanged formal plan v1.0.1-r1 stays in its existing external Drive location, SHA `a918f42e6e9de160f7b14a95afafeae9022ddcc189b3663e768aa197110118a4`. No full narrative copy is added to Git. The earlier proposal is source evidence, not acceptance: JSON SHA `8223b918471f8ef8a33207509c0052322b894824b596280c601395d224bb9fd1`, text SHA `9e1917c5dcead7de060d262403577407396d74a0333b6feecaec1d60ffa22baf`.

## Exact clause successors

| Fixed plan clause | Engineering successor |
|---|---|
| §7.2 M3 entry | Before complete M2, permit preparation of bounded T0/T1 engineering under reviewed exact inputs of an existing ExperimentAuthorizationProfile. T2/T3 expansion, full M3 verdict, qualification inheritance and release still require complete accepted M2. |
| §11.5 split/freeze | Before selection feedback, really freeze reserved source-pool manifest, near-duplicate groups, sampling version/size/statistical rationale, custody, allowed consumers and failure/scoring rules, with actual access isolation. Generate actual final Holdout questions after the exact final product candidate is fixed and before formal product qualification. |
| §11.6 M2/DataGate | Fix the M2 reference/deterministic baseline for its qualification purpose first, then independently generate/consume existing `qualification` samples and actual Gold/threshold/DataGate evidence. This reference is not the later product candidate. |
| §11.8 acceptance | Preserve separate purpose-bound reference/product candidate and evidence identities. M2 qualification closes before full M3; product `final_holdout` consumption follows product candidate freeze. No final-use inheritance from M2 consumption. |

These clauses resolve the ordering cycle without introducing another Gate or dataset category:

`fixed M2 reference → qualification samples / DataGate → full M3 → final product candidate → independently generated final_holdout → formal product qualification`.

Actual reserved-input freeze and isolation precede **any selection feedback**. This requirement is not a requirement to generate final questions before an engineering smoke. Final weights, tokenizer, inference configuration and scorer are frozen before final questions are generated; final feedback cannot change selection or justify a redraw.

## Development and full qualification

`DevelopmentFoundation` names only the exact reviewed input set of an existing ExperimentAuthorizationProfile. It is not another Authority, Kernel Gate or runtime admission. Preparation output is candidate-only and `NOT_ISSUED`; actual data, device, size, budgets, stop conditions and execution window still need exact current authority. The frozen M0-only Profile schema is unchanged and cannot itself issue a T0/T1 execution authorization.

Reuse the four existing parent scopes `TRAINING / DEVELOPMENT / QUALIFICATION / FINAL_HOLDOUT` and six existing purpose IDs `training / development / calibration_fit / selection_policy_validation / qualification / final_holdout`. Do not invent categories or infer a purpose-to-parent mapping absent from the bound existing definition. Any weight learning consumes only the approved `TRAINING` partition with purpose `training`; `development` is for non-learning engineering. Engineering smoke is not final selection evidence. Candidate selection comparisons additionally require the preselection actual freeze. No protected48, qualification or final Holdout access is granted to development smoke. Public visibility is not a license; synthetic data requires explicit approval.

The metadata sharing-lock reproof branch is cancelled because the design is already statically refuted. Enhanced continuous-handle design remains HOLD. No actual Host issue is closed, no current failed path is exempted, and no expired credential/window is extended. A fixed runner must have actual reviewed availability, applicable trust boundaries and fresh Profile admission; it cannot be declared trusted by its caller.

Reuse unchanged applicable M1/DatasetSplit/Owner-designation evidence. Recheck affected bindings on source, purpose, role, consumer or custody changes. Ordinary Owner adoption receipts do not become DomainAuthorityReceipts; actual Gold, thresholds, DataGate and independent acceptance remain required.

The total objective remains M0–M7, including M5A. M6 is the first-release milestone after the required three-Tier qualification, Stable/ProductActivation and independent review; it does not complete the whole task or silently defer M7.

## Consumer and implementation boundary

PR [441](https://github.com/tdoljyj/cross-memory-system/pull/441) at `e76a7db7edc6b47b5a719e165f688621efa9580a` is an unmerged Draft impact source. The impact matrix lists its exact external paths/hashes. This change preserves those frozen upstream consumers and adds explicit scoped consumer entries using their byte-pinned source fixtures; see `m2-scoped-successor/README.md`. The scoped entries do not provide a live domain backend. Runtime sourceRole/data permissions and actual Profile issuance are not implemented by these documents (Task `1502fd80`). The remaining work stays under the original Task and adoption Decision; no design-reference string or candidate boolean grants permission.

Existing Kernel-only Authority, frozen M0/M1 contracts and their CI entries remain unchanged. A separately gated M2 scoped consumer workflow is new. Publication, training, evaluations, native effects and production require their own applicable admissions.
