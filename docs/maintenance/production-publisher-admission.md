# Dispatch publisher Source admission

This extends the existing work-claim dispatch gate. It does not qualify a VM,
register a runner, grant production access, or change the production workflow.
The production environment, exact-commit Owner Grants, backups and seven release
proofs retain their existing rules. The runner cost policy in the Runner Runbook
§2.4 also applies; an unavailable publisher is not a paid fallback permission.

## Source registration before consumers

`scripts/ci/clued-production-publisher-sources.json` binds two fixed paths: the
production publisher and its separate qualification workflow. Registration binds
raw UTF-8 Git bytes, Git blob identity, SHA-256, the complete parsed definition,
independently reviewed primary-role digests and command digests. CRLF equivalence
cannot substitute for a different registered Git object. The only retained legacy
Source is the exact existing production predecessor. It cannot authorize a new
runner or a new workflow.

The compiler uses the locked YAML parser at registration time. Runtime consumers
read the fixed catalogue from their trusted default checkout, not a PR profile,
caller workspace or an environment-selected path. Unknown, revoked, ambiguous or
modified sources fail closed. A candidate catalogue in a feature branch grants
nothing. Source/Role changes pass the normal protected-file PR admission and exact
head Owner door before they can become trusted default-branch data.

Land the reviewed Source and admission successor first; install only its exact
registered workflow bytes in the consumer PR afterward. A new qualification
source must be frozen with its complete job roles before registration and before
it is added to the dispatch input list. It must not invent a PR trigger merely to
fit the existing PR-proof compiler. Its actual runner isolation remains a
separate acceptance requirement.

## Two consumers and final barriers

The admission guard retains the canonical gate digest, job dependency and gated
condition checks. Its narrow predecessor conversion applies only to the named
production workflow with a modified-file identity. Renamed, copied and newly
added production files cannot borrow it.

The complete workflow catalogue validates registered non-PR successors against
their exact default predecessor, full roles and canonical gate. They stay outside
the required PR test set. Default CI enumeration excludes a dispatch publisher
only when its full trusted Source qualifies; a basename alone is insufficient.
The catalogue and compiler bytes join the bounded trusted snapshot and the final
Source/default-tip recheck. Existing PR profile/role raw hashes and PR execution
template capacity do not change.

The existing five-target `clued-work-admission-dispatch.yml` and its hosted
control prefix remain unchanged. This Source foundation does not install a new
execution route. Attempts to dispatch either publisher target return
`REJECTED/publisher_dispatch_not_installed` before network reads. In particular,
an absent dispatch-list entry cannot produce `NOT_APPLICABLE` admission for
these targets. A separately reviewed, qualified self-hosted admission controller
must be installed before extending that list. Its eventual consumer must retain
the live scoped claim, exact head, required `admission_run_id`, short admission
TTL and current execution epoch. Existing hosted migration debt grants no new
paid bootstrap exception.

The proposed one-shot publisher route has the fixed production label plus the
literal GitHub expression `clued-publisher-<run_id>-<run_attempt>`. A trusted
launcher must bind that exact job and Source before steps. A workflow label or
job-authored attestation cannot establish isolation or production qualification.
Until those real qualifications pass, no production runner or Secrets are enabled.

## Nonproduction PR bootstrap

The separate `clued-publisher-qualification-source.mjs` contract registers only
the fixed Host and Guest qualification workflows. Each has one concrete primary
role, the original canonical gate, a fixed self-hosted route, bounded timeout,
no environment or stored Secrets, and a checkout of the exact same-repository
Owner PR head without persisted credentials. Its only trigger is a PR into main,
with paths limited to the named qualification sources. Production stays dispatch-only.

The catalogue binds the full Host and Guest bytes from
`229d8fb84df17feca9568d7821e7e62e907b1b86`, including every job's complete Role.
Registration requires the four normal PR event types, the exact finite affected
path filters, the same-repository base and head plus Owner author and actors,
and the canonical job temporary-storage action. Node setup and checkout use the
reviewed full action SHAs; the only command invokes the fixed public case CLI.
Those Source and Role entries must become trusted protected default-branch data
before a consumer PR can install them. A candidate cannot enroll itself. This
does not reuse the seven handover registrations or change PR profile/role raw
hashes or capacity. Source registration is not actual Host/Guest qualification.

Both complete catalogue consumers authenticate these sources, but classify them
as `qualification_only`. Existing required application CI remains required and
must pass. Expected canary failure and cancellation are separate evidence and
cannot count as a green application test. Host launch still needs to bind the
native PR/head, workflow source, run, attempt and job before registration; a
workflow name, matching label or job-authored result is insufficient.

## Existing observation history

The exact predecessor at main `80bd559f283b7c009cd37f1fbde700b6d6be41ae` is sealed
as a bounded offline regression fixture. Each natural producer retains its five
previous definitions and appends the actual preceding definition, within a new
bound of six prior generations. Older map-only history retains its bound of four;
the separate PR execution-template bound is unchanged. Historical descriptor and
cache identities remain exact, and a seventh prior generation is refused before
network reads. These observations grant no execution or metric authority.

The registry pins the exact bytes of the current generation. Its history was already
at capacity (six source generations per producer, four prior admission Sources, four
prior execution Sources) when it was re-pinned after drifting from 9e9d3fa66, so
the re-pin replaced that generation instead of retaining it. Two generations are
therefore not retained: the admission script `b413917364fc` and the execution
Source with profiles `cdaf73165378` / role specs `7cddf4abf791` (the producer
source maps registered at 9e9d3fa66 are dropped with them). Generations between
that registration and the re-pin were never registered. The drift guard is
`merge-admission-source-producer.test.mjs`, which runs in `clued-cloud-tests`.
