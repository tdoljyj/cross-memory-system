// E2E-01: Native capture -> Candidate -> Native two-step confirmation ->
// Authority Information -> Context Policy -> MSCP consumed by the Agent.
import { acceptPolicy, checkPack, issueCandidate, packExtract, policyDoc, promoteCandidate, readFixture, submitExtract,
  key } from './common.mjs';
import { sha256 } from '../evidence.mjs';

export const id = 'E2E-01';

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p01;
  r.alias('P01', scope.slice(8));
  // Vendored M0-A smoke fixture SMK-CAN-001 (segment + candidate document).
  const segmentInput = readFixture('m0a/fixtures/smoke/SMK-CAN-001/input.json');
  const document = readFixture('m0a/fixtures/smoke/SMK-CAN-001/output.json');
  // The fixture item is a task; the promotion mapping needs an explicit
  // execution bucket for tasks, so the Native user chooses 'later' at step 1.
  const submit = await r.rest(U, 'POST', '/v1/intake', { idempotency_key: key('e01'), scope, segment: segmentInput,
    candidates: document }, { extract: submitExtract });
  r.check('01.submit', 'Native submit commits', 'committed', submit.body?.status);
  const candidateId = r.alias('C1', submit.body?.supplemental?.candidates?.[0]?.id);
  const evidenceId = r.alias('E1', submit.body?.evidence_ids?.[0]);
  const serverHash = submit.body?.supplemental?.segment_sha256;
  r.check('01.server_hash', 'the submit returns a server-computed segment hash', true, /^[0-9a-f]{64}$/.test(serverHash ?? ''));

  const listed = await r.rest(U, 'GET', `/v1/intake?status=pending&scope=${encodeURIComponent(scope)}`, undefined,
    { extract: (b) => ({ ids: b?.candidates?.map((c) => c.id), authoritative: b?.candidates?.map((c) => c.authoritative) }) });
  r.checkSet('01.listed_pending', 'the candidate lists as pending', [candidateId],
    listed.body?.candidates?.map((c) => c.id));

  const issued = await issueCandidate(r, U, 'information', candidateId, { authority: 'observed',
    native_type_fields: { execution_bucket: 'later' } });
  r.check('01.issue', 'step 1 issues a confirmation token (observed authority)', 'issued', issued.body?.status);
  r.check('01.issue_no_store', 'the token response is not cacheable', 'no-store', issued.headers?.cache_control);
  const recordId = r.alias('R1', issued.body?.record_id);
  const promoted = await promoteCandidate(r, U, 'information', candidateId, issued.body ?? {});
  r.check('01.promote', 'step 2 promotes the candidate', ['committed', 'promoted', 1],
    [promoted.body?.status, promoted.body?.supplemental?.outcome, promoted.body?.supplemental?.record_version]);
  r.check('01.promote_rpc_once', 'the promote step runs clued_candidate_promote_v1 exactly once through the Worker',
    1, r.steps.at(-1).ledger.filter((row) => row.path_class === 'rpc:clued_candidate_promote_v1').length);

  const policy = await acceptPolicy(r, U, policyDoc('e2e.01', [scope], { require_evidence: true,
    fields: { required: ['title', 'content'], optional: [] } }));
  r.alias('POL1', policy.policyId);

  const init = await r.mcp(B, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'ife2e-agent', version: '1.0.0' } }, { extract: (b) => ({ protocol: b?.result?.protocolVersion }) });
  r.check('01.mcp_initialize', 'the Agent initializes an MCP session', 200, init.status);
  const packed = await r.tool(B, 'clued_context_pack', { scope, task_class: 'e2e.01' }, { extract: packExtract });
  const pack = packed.structured;
  if (checkPack(r, '01', pack)) {
    const itemsOut = pack.pack.items;
    r.check('01.item_exact', 'the pack contains exactly the promoted Record at version 1',
      [[recordId, 1]], itemsOut.map((row) => [row.canonical_id, row.version]));
    r.check('01.evidence_hash', 'the item carries the submit Evidence id and the server-computed hash',
      [{ evidence_id: evidenceId, content_hash: serverHash }],
      (itemsOut[0]?.evidence ?? []).map((row) => ({ evidence_id: row.evidence_id, content_hash: row.content_hash })));
    r.check('01.human_confirmed', 'the item is human_confirmed', true, itemsOut[0]?.human_confirmed);
    r.check('01.claims', 'authoritative, execution not granted, model extraction not evaluated',
      [true, 'NOT_GRANTED', 'NOT_EVALUATED'],
      [pack.pack.authoritative, pack.pack.execution_authorization, pack.pack.model_extraction]);
    r.check('01.tokenizer', 'token counts are measured in workerd and labelled offline_target',
      ['measured', 'offline_target', 'pack_text'],
      [pack.measurement?.status, pack.measurement?.tokenizer_status, pack.measurement?.counted]);
    r.check('01.measurement_binds_digest', 'the measurement is bound to the pack digest', pack.pack_digest,
      pack.measurement?.pack_digest);
    r.check('01.policy_bound', 'the pack names the accepted policy', policy.policyId, pack.pack.policy?.id);
    ctx.shared.e01 = { packDigest: pack.pack_digest, textSha: sha256(pack.pack_text) };
  }
  return {};
}
