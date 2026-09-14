-- OFFLINE SOURCE CANDIDATE ONLY. NOT AN INSTALL SCRIPT. DO NOT EXECUTE.
--
-- Integration point: inside clued_control.reserve_gate(text,text), replace only
-- the existing allocation binding/window IF block with this block. Add these
-- variables to the function DECLARE list:
--
--   repoint clued_control.execution_events;
--   correction_event clued_control.execution_events;
--   root9_qualification_event clued_control.execution_events;
--   inherited_budget jsonb;
--   previous_binding jsonb;
--   replacement_binding jsonb;
--   correction_evidence_sha text;
--   expected_p3_publication_uri constant text := '__P3_PUBLICATION_EVIDENCE_URI__';
--   expected_p3_publication_sha constant text := '__P3_PUBLICATION_EVIDENCE_SHA256__';
--   expected_review_uri constant text := '__INDEPENDENT_REVIEW_URI__';
--   expected_review_sha constant text := '__INDEPENDENT_REVIEW_SHA256__';
--   expected_correction_evidence_sha constant text := '__CORRECTION_EVIDENCE_JSONB_SHA256__';
--
-- The enclosing function must retain its current signature, SECURITY DEFINER,
-- empty search_path, locks, series verifier, status check, insert/update, ACLs,
-- and all other statements byte-for-byte. This candidate only recognizes the
-- exact sequence-104 inheritance of the already committed sequence-102 budget.

previous_binding := jsonb_build_object(
  'root_id','ctr_414bd3c724264a83894b0c55cf2ab878',
  'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  'controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
  'qualification_sha256','171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71',
  'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'gate_id','G-PREENTRY-SKILL-QUALIFICATION',
  'gate_version','fixed-synthetic-20260910.v10-env-order-repair',
  'gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  'runtime_acceptance_sha256','107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9',
  'prior_seconds',1506,
  'prior_evidence_bytes',322546611);

replacement_binding := previous_binding || jsonb_build_object(
  'controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'qualification_sha256','a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013',
  'runtime_acceptance_sha256','c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552');

inherited_budget := jsonb_build_object(
  'budget_sequence',102,
  'budget_reservation_ref',jsonb_build_object(
    'uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:102',
    'sha256','51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'),
  'original_controller_sha256','c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b',
  'replacement_controller_sha256','c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a',
  'root_generation','ctrgen_308a1dfc185cff633892638581e0a34c',
  'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  'runner_generation','runnergen_a256855fec9441839105c69b746c5244',
  'credential_generation','credgen_bac92a11e7144a3fb9e67f40a6a07d11',
  'session_generation','sessiongen_ffb02a907d334b0da0b37bf457a758c2',
  'reason','POST_BUDGET_ROOT9_DYNAMIC_SIGNING_REPAIR',
  'additional_allocation',false,
  'automatic_refund',false,
  'remaining_seconds',600,
  'remaining_evidence_bytes',134217728);

-- Every allocation field except controller_digest retains the original general
-- comparison. The old controller may differ only through the exact branch below.
if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest'
 or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation'
 or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer
 or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;

if allocation->>'controller_digest' is distinct from g->>'controller_digest' then
  select * into root9_qualification_event
    from clued_control.execution_events
   where root_id=root and sequence=100;
  select * into correction_event
    from clued_control.execution_events
   where root_id=root and sequence=103;
  select * into repoint
    from clued_control.execution_events
   where root_id=root and sequence=104;
  correction_evidence_sha := encode(sha256(convert_to(
    (correction_event.request->'body'->'evidence')::text,'UTF8')),'hex');

  if budget.sequence is distinct from 102
   or budget.idempotency_key is distinct from 'root9_final_skill_qualification_budget_v1'
   or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
   or (select array_agg(k order by k) from jsonb_object_keys(budget.request) k)
        is distinct from array['body','operation']::text[]
   or (select array_agg(k order by k) from jsonb_object_keys(budget.request->'body') k)
        is distinct from array['raw','sha256']::text[]
   or budget.request->'body'->>'sha256' is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
   or encode(sha256(convert_to(budget.request->'body'->>'raw','UTF8')),'hex')
        is distinct from '51eeb017ff28e5c15848a726de43436fe8421a8c574c0cdbdbce84a1aefc9e2a'
   or (select array_agg(k order by k) from jsonb_object_keys(allocation) k) is distinct from
        array['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']::text[]
   or allocation->>'controller_digest' is distinct from 'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b'
   or allocation->>'root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or allocation->>'profile_digest' is distinct from 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5'
   or allocation->>'scope_digest' is distinct from '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'
   or allocation->>'runner_generation' is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
   or allocation->>'credential_generation' is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
   or allocation->>'session_generation' is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
   or allocation->>'environment' is distinct from 'ISOLATED_TEST'
   or allocation->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
   or allocation->>'idempotency_key' is distinct from 'root9_final_skill_qualification_budget_v1'
   or allocation->'seconds' is distinct from '600'::jsonb
   or allocation->'evidence_bytes' is distinct from '134217728'::jsonb
   or (allocation->>'not_before')::timestamptz is distinct from '2026-09-14T03:00:00Z'::timestamptz
   or (allocation->>'expires_at')::timestamptz is distinct from '2026-09-15T03:00:00Z'::timestamptz
   or c.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or c.sequence is distinct from 104
   or c.pending_budget_sequence is distinct from 102
   or c.active_ga_id is not null
   or c.charged_seconds is distinct from 11106
   or c.charged_evidence_bytes is distinct from 2470030259
   or c.runner_generation is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
   or c.credential_generation is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
   or c.session_generation is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
   or w.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or w.generation_id is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or w.is_successor is distinct from true
   or w.budget_sequence_floor is distinct from 98
   or w.not_before is distinct from '2026-09-14T03:00:00Z'::timestamptz
   or w.expires_at is distinct from '2026-09-15T03:00:00Z'::timestamptz
   or b.root_id is distinct from 'ctr_414bd3c724264a83894b0c55cf2ab878'
   or b.profile_sha256 is distinct from 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5'
   or b.controller_sha256 is distinct from 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
   or b.qualification_sha256 is distinct from 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'
   or b.scope_sha256 is distinct from '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'
   or b.gate_id is distinct from 'G-PREENTRY-SKILL-QUALIFICATION'
   or b.gate_version is distinct from 'fixed-synthetic-20260910.v10-env-order-repair'
   or b.gate_sha256 is distinct from '3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a'
   or b.runtime_acceptance_sha256 is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or b.prior_seconds is distinct from 1506
   or b.prior_evidence_bytes is distinct from 322546611
   or g->>'control_trust_root_generation' is distinct from 'ctrgen_308a1dfc185cff633892638581e0a34c'
   or g->>'profile_digest' is distinct from 'd1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5'
   or g->>'controller_digest' is distinct from 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
   or g->>'scope_digest' is distinct from '115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'
   or g->'controller_qualification_ref'->>'sha256' is distinct from 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'
   or g->>'runner_generation' is distinct from 'runnergen_a256855fec9441839105c69b746c5244'
   or g->>'credential_generation' is distinct from 'credgen_bac92a11e7144a3fb9e67f40a6a07d11'
   or g->>'session_generation' is distinct from 'sessiongen_ffb02a907d334b0da0b37bf457a758c2'
   or correction_event.sequence is distinct from 103
   or correction_event.recording_transaction_id is null
   or correction_event.recording_transaction_id=pg_current_xact_id()
   or correction_event.idempotency_key is distinct from 'root9_postbudget_dynamic_signing_repair_v1_qualification'
   or correction_event.request->>'operation' is distinct from 'SUCCESSOR_BINDING_QUALIFICATION_CORRECTED'
   or (select array_agg(k order by k) from jsonb_object_keys(correction_event.request) k)
        is distinct from array['body','operation']::text[]
   or (select array_agg(k order by k) from jsonb_object_keys(correction_event.request->'body') k)
        is distinct from array['binding_id','evidence','evidence_sha256','status_manifest_ref','supersedes_execution_sequence']::text[]
   or correction_event.request->'body'->>'binding_id' is distinct from 'sb_201178b7a8111000d515f7f26a75a28b'
   or correction_event.request->'body'->'supersedes_execution_sequence' is distinct from '100'::jsonb
   or correction_event.request->'body'->>'evidence_sha256' is distinct from correction_evidence_sha
   or correction_evidence_sha is distinct from expected_correction_evidence_sha
   or (select array_agg(k order by k)
         from jsonb_object_keys(correction_event.request->'body'->'evidence') k) is distinct from
        array['authority_effect','controller_file_count','defect_code','independent_review_ref','new_controller_sha256','new_qualification_sha256','new_runtime_acceptance_sha256','p2_publication_ref','p3_publication_ref','pending_budget_inheritance','required_repair_refs','status_manifest_ref']::text[]
   or correction_event.request->'body'->'evidence'->>'authority_effect' is distinct from 'NONE'
   or correction_event.request->'body'->'evidence'->'controller_file_count' is distinct from '23'::jsonb
   or correction_event.request->'body'->'evidence'->>'defect_code' is distinct from 'ROOT9_DYNAMIC_SIGNING_HELPER_NOT_MANIFEST_COVERED'
   or correction_event.request->'body'->'evidence'->>'new_controller_sha256' is distinct from 'c0b49c6a782efe219485486c120c05a7b5e7171394194cebc8b7aec76047d10a'
   or correction_event.request->'body'->'evidence'->>'new_qualification_sha256' is distinct from 'a48aa5934112cc968c622c200c7b994d7b928e0bb3d433b49b3d741680a57013'
   or correction_event.request->'body'->'evidence'->>'new_runtime_acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or correction_event.request->'body'->'evidence'->'pending_budget_inheritance' is distinct from inherited_budget
   or (select array_agg(k order by k) from jsonb_object_keys(g->'status_manifest_ref') k)
        is distinct from array['sha256','uri']::text[]
   or correction_event.request->'body'->'status_manifest_ref' is distinct from g->'status_manifest_ref'
   or correction_event.request->'body'->'evidence'->'status_manifest_ref' is distinct from g->'status_manifest_ref'
   or correction_event.request->'body'->'evidence'->'p2_publication_ref' is distinct from
        jsonb_build_object(
          'uri','https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/bfc65714f9b596c6140c745948185e92665a48dd',
          'sha256','dec179df0626c5f22bb33a979336430dd136c8a54895666bae2ce4b2b0eae887')
   or correction_event.request->'body'->'evidence'->'p3_publication_ref' is distinct from
        jsonb_build_object('uri',expected_p3_publication_uri,'sha256',expected_p3_publication_sha)
   or correction_event.request->'body'->'evidence'->'independent_review_ref' is distinct from
        jsonb_build_object('uri',expected_review_uri,'sha256',expected_review_sha)
   or expected_p3_publication_uri !~ '^https://api[.]github[.]com/repos/tdoljyj/cross-memory-system/git/blobs/[0-9a-f]{40}$'
   or expected_p3_publication_sha !~ '^[0-9a-f]{64}$'
   or expected_review_uri !~ '^https://api[.]github[.]com/repos/tdoljyj/cross-memory-system/git/blobs/[0-9a-f]{40}$'
   or expected_review_sha !~ '^[0-9a-f]{64}$'
   or expected_correction_evidence_sha !~ '^[0-9a-f]{64}$'
   or jsonb_typeof(correction_event.request->'body'->'evidence'->'required_repair_refs') is distinct from 'array'
   or jsonb_array_length(correction_event.request->'body'->'evidence'->'required_repair_refs') is distinct from 8
   or root9_qualification_event.sequence is distinct from 100
   or root9_qualification_event.request->>'operation' is distinct from 'SUCCESSOR_BINDING_QUALIFIED'
   or correction_event.request->'body'->'evidence'->'required_repair_refs' is distinct from
        root9_qualification_event.request->'body'->'evidence'->'required_repair_refs'
   or repoint.sequence is distinct from 104
   or repoint.recording_transaction_id is null
   or repoint.recording_transaction_id=pg_current_xact_id()
   or repoint.recording_transaction_id is distinct from correction_event.recording_transaction_id
   or repoint.idempotency_key is distinct from 'root9_postbudget_dynamic_signing_repair_v1_repoint'
   or repoint.request->>'operation' is distinct from 'EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
   or (select array_agg(k order by k) from jsonb_object_keys(repoint.request) k)
        is distinct from array['body','operation']::text[]
   or (select array_agg(k order by k) from jsonb_object_keys(repoint.request->'body') k) is distinct from
        array['acceptance_raw','acceptance_sha256','binding_id','new_binding','new_binding_sha256','new_runtime_acceptance_sha256','old_runtime_acceptance_sha256','pending_budget_inheritance','previous_binding','previous_binding_sha256','qualification_correction_sequence','qualified_evidence','supersedes_execution_sequence']::text[]
   or repoint.request->'body'->>'binding_id' is distinct from 'sb_201178b7a8111000d515f7f26a75a28b'
   or repoint.request->'body'->'supersedes_execution_sequence' is distinct from '101'::jsonb
   or repoint.request->'body'->'qualification_correction_sequence' is distinct from '103'::jsonb
   or repoint.request->'body'->'previous_binding' is distinct from previous_binding
   or repoint.request->'body'->>'previous_binding_sha256' is distinct from
        encode(sha256(convert_to(previous_binding::text,'UTF8')),'hex')
   or repoint.request->'body'->'new_binding' is distinct from replacement_binding
   or repoint.request->'body'->>'new_binding_sha256' is distinct from
        encode(sha256(convert_to(replacement_binding::text,'UTF8')),'hex')
   or repoint.request->'body'->>'old_runtime_acceptance_sha256' is distinct from '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9'
   or repoint.request->'body'->>'new_runtime_acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or repoint.request->'body'->>'acceptance_sha256' is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or encode(sha256(convert_to(repoint.request->'body'->>'acceptance_raw','UTF8')),'hex')
        is distinct from 'c1456fd186da21a707693af18f3dce5fdf1dcd54d7cc1b3c661290476f162552'
   or repoint.request->'body'->'pending_budget_inheritance' is distinct from inherited_budget
   or repoint.request->'body'->'qualified_evidence' is distinct from correction_event.request->'body'->'evidence'
  then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
end if;
