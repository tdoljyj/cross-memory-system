# Scoped control context verification candidate

State: **CANDIDATE_NOT_ACTIVATED / LOCAL_ENGINEERING_ONLY**. This package reads and checks existing control objects; it does not issue an authorization, sign a receipt, create a root, deploy SQL, run a Skill, or change the original six core object categories. Production and PQUAL-18 remain outside scope.

## Actual entry and trust boundary

`tool-entry.functions.js` is a fixed root-operated tool program. It calls only the existing Supabase tool for project `uscrdifznmlvczcekqpw` and the exact query exported in `context.mjs`. The connector call, its selected project/query and the unchanged root program constitute the source boundary. A JSON member such as `authorized`, `stored`, or `verified` cannot establish that boundary.

The entry starts the exact observed Node binary, clears process-local Node injection options, and sends material through a live PTY with echo disabled. `cli.mjs` obtains actual GitHub API responses through the fixed, hashed GitHub CLI. It retains checked bytes and a once-only finishing closure inside that process. Only after signature checks does it emit a random challenge. The same root program then obtains another actual SQL result and sends it with the challenge into the same process. No serialized capability or process brand is accepted. Returned output is for the immediate trusted supervisor check; it is not a transferable authorization token. The supervisor must still execute its fixed current-state CAS and host checks before each effect.

The actual tool host closed non-PTY stdin during a local check. The PTY follow-up retained stdin, did not echo the submitted material, and returned the expected BLOCKED outcome for missing SQL. Actual terminal control bytes are covered by the parser regression. No SQL or signature-network positive was fabricated to exercise this bridge.

The complete controller source manifest is assembled by the host owner from this package's `SourceBindings.json` and its own host/supervisor closure. That exact manifest must be checked **before launching this code** and independently qualified. This package does not equate a caller's controller digest with executable integrity. Its dependency catalog records actual loaded Ajv modules and resolution metadata for the host's closure; it does not itself claim an immutable OS filesystem or an accepted controller qualification.

## Checks and current exact scope

- Original complete GA schema; exact compact UTF-8 JSON plus LF; duplicate/unsafe numeric encodings rejected; purpose, audience, Root generation 2, registered Gate/version/digest, qualified controller, scope and every fixed GA field bound to the independently accepted runtime subject.
- Fresh SQL observation (15 seconds), exact private project/root, complete Root history and prefix commitment, current revocation/validity, immutable active GA reservation, no existing result or redispatch, independent runner/credential/session generations, cumulative budgets and deadlines.
- Exactly the signed synthetic Profile's four business-layer N/A reasons and accepted schema refs; no blanket N/A or inferred epoch. This revision binds the actually signed **90-second Profile / PR28**, not the unaccepted 180-second successor. A later accepted 180-second Profile requires an explicit affected source/digest successor.
- Actual Owner `tdoljyj` / `web-flow` verified PR merge, exact complete tree and ordinary blob bytes for Root, Profile, Gate and prerequisite/acceptance source artifacts. Immutable objects and verified merged trees are reused only inside this process. Dynamic GA/GRR use the already independently accepted fixed one-parent commitment verifier and exact generation-2 purpose metadata. STATUS retains the original PR-merge algorithm.
- Full Status raw bytes must occur once in the actual SQL `control_objects` result under the exact GA reference. Its exact accepted schema, signature payload, source refs/digests, observed profile/gate/controller/scope/generations, and expiry are checked. A supplied boolean or a supplied digest alone is insufficient.

## Original Status / GRR schema successors

The original S06 source is the ZIP member recorded in `SourceBindings.json`, SHA256 `f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec`.

| Source | Existing obligation | This explicit scoped encoding |
|---|---|---|
| L3878, L3885, L4308 | Status ID, as-of, generation, source digests, expiry, issuer/purpose/schema/signature; immutable `control://status-manifests/<id>` | `status-manifest.candidate.schema.json`; full `sm_…` ID in URI; `{uri,sha256}` refs; safe integer generation; exact observation fields and source refs; PR merge `signature_binding` excluded only from signing payload |
| L3441, L3880, L3885, L3891–3894, L4310 | One GA/one GRR; exact tests/fixtures/executor/performance revision/input/evidence/writes/times/actors; PASS, FAIL, BLOCKED or STALE | `gate-result-receipt.candidate.schema.json`; exact GA raw digest and Gate ref; per-test oracle/evidence refs; original decision reservation and STOP evidence bindings; no UNKNOWN terminal result |
| L3435–3441, L4320–4346 | Immutable static Gate/Test definitions; dynamic authorization and result remain separate; typed references and original store responsibility | Existing static Gate and private control source reused; no second Registry, Auth, Receipt family or business Canon |

Field encodings absent from the original prose are proposed here, not represented as historical wire literals. The Status generation safe-integer limit is an implementation constraint, not a newly asserted original bound. Neither schema creates an instance. Exact independent schema acceptance and publication must precede use; original core schema/manifest files are not changed here. The already accepted dynamic GA/GRR detached proof URNs remain unchanged.

`grr.mjs` currently checks complete result shape, exact original GA/decision/Gate, unique STOP raw bytes and stopped container, ordered times, write containment, no repeated test IDs and full 19-case PASS coverage with current generations. Its optional actual historical signature check is explicitly **not final receipt admission**. The same-domain original raw evidence/index and per-test oracle resolution, independently adjudicated result, fresh reservation and terminal CAS must still be joined before GRR issuance. In particular, an expired GA must never receive PASS; safe non-PASS convergence needs the explicit result path, not the CREATE/START live-GA path. No STOP or results are invented for an attempt that never started.

## Exact runtime material contract (ordinary metadata, no instance)

The root's in-memory `clued_exact_reviewed_ga_material` contains `ga_raw`, `operation` (`CREATE`, `START` or pre-result live-context `GRR`), and these actual immutable inputs:

- `runtime_acceptance` and `controller_qualification`: `{raw, publication:{commitSha,artifactPath}}`; raw bytes must hash to the actual SQL binding's respective digest and occur in a real verified Owner merge.
- `gate_definition`: the exact standalone Gate definition bytes with the same publication structure. `prerequisite_materials`: `{ref,raw,publication}` entries for the exact Profile acceptance, R05–R10 and any upstream GRR refs.
- `status_manifest`: `{raw,store_ref,source_binding_sha256,payload_raw,publication}`. `store_ref` equals GA `status_manifest_ref`, `source_binding_sha256` is the runtime acceptance digest, while actual storage is independently established by the SQL read. `payload_raw` is the actually PR-signed Status object excluding only `signature_binding`.
- `observation` is supplied/overwritten only by the fixed tool entry, shaped `{project,query_sha256,row:{observed_at,execution}}`. `execution` is the original `read_execution` object with full Root, binding, current, attempts, events and the active GA's unique `{object_type:'StatusManifest',uri,raw,sha256}` control object. No external query/tool/host argument is accepted.

The ordinary runtime acceptance format proposed for independent issuance is `state=ACCEPTED_EXACT_PREENTRY_CONTROLLER_RUNTIME`, `independent_reviewer=/root/project_list_auth_fix`, actual `not_before/expires_at`, and `accepted_subject` containing fixed `root_id`, `project_ref`, `gate:{gate_id,definition_version,content_digest}`, `required_stages:[R05…R10]`, exact accepted `control_schema_refs:{StatusManifest,GateResultReceipt}`, and `expected_ga`. `expected_ga` fixes every original required GA field except the explicitly dynamic ID/status/time/idempotency/signature and runner/credential/session values listed in the verifier. Dynamic values are separately checked against the live reservation/current source, never left as arbitrary authorization scope.

The ordinary qualification format is `state=ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION`, the independent reviewer, exact `controller_digest/scope_digest`, `environment=ISOLATED_TEST`, `purpose=SKILL_COEXISTENCE_QUALIFICATION`, real `not_before/expires_at`, and independently determined `independent_of_tested_skill=true` and `forbidden_stage_dependencies_excluded=true`. These fields require real independent assessment and real signed source bytes. Existing engineering review `62e09c32…` is **not** that qualification and is never seeded into these fields. These formats are candidate metadata encodings for the original responsibility, not new core objects or a qualification issued by this implementation.

## Verification and outstanding actual inputs

The final local suite has 7 passing tests, no skips: parser and shape negatives, invalid calendar/unsafe generation, original result enum/evidence requirements, numerical time ordering, an actual no-network CLI rejection, and parsing actual observed PTY controls. A separate actual PTY session confirmed missing SQL rejection without echo. These do not prove valid private SQL/GitHub admission, controller/PQUAL qualification, R11 or Slice A completion.

Actual accepted runtime/controller qualification, the complete prelaunch source closure, accepted Status/GRR schema refs and stored signed Status, Root2/current exact runtime binding, and the later accepted Profile successor remain real assembly inputs. Missing or changed values fail closed. Root and host owners are implementing/publishing these within the existing approved nonproduction scope; they are not requests for another Owner authorization.
