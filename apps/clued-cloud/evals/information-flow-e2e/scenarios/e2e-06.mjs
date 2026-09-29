// E2E-06: SEC-001…008 injection texts through both entries. Tier, scope,
// authority and target are fixed by the route; the texts stay data; no
// external action happens and no Canonical state changes.
import { canonicalSnapshotSql, key, nativeNote, readFixture } from './common.mjs';

export const id = 'E2E-06';

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p06;
  r.alias('P06', scope.slice(8));
  const source = r.alias('SRC', await nativeNote(r, U, 'E2E-06 knowledge source', { scope }));
  const egressStart = ctx.h.worker.egress.length;
  const baseline = (await r.observe('canonical snapshot', canonicalSnapshotSql, [U.userId]))[0];
  const send = {
    agent: (body) => r.tool(B, 'clued_intake_submit', body, { extract: (b) => ({ status: b?.status,
      error_code: b?.error_code ?? null }) }).then((res) => res.structured),
    native: (body) => r.rest(U, 'POST', '/v1/intake', body, { extract: (b) => ({ status: b?.status,
      error_code: b?.error_code ?? null }) }).then((res) => res.body),
  };
  const dataKeys = { agent: [], native: [] };
  for (let n = 1; n <= 8; n += 1) {
    const sec = `SEC-00${n}`;
    const input = readFixture('m0c/corpus/security', sec, 'input.json');
    const output = readFixture('m0c/corpus/security', sec, 'output.json');
    const injection = input.messages.map((message) => message.content).join('\n');
    const active = input.messages.find((message) => message.context_only === false);
    const asData = { schema_version: 'candidate_information.v1', segment_id: input.segment_id,
      items: [{ candidate_local_id: 'item_injection_as_data', item_type: 'fact', claim: active.content.slice(0, 300),
        summary: active.content.slice(0, 120), action_level: 'reference', priority: null, entity_mentions: [], topics: [],
        temporal_mentions: [], source_anchors: [{ message_id: active.message_id, exact_quote: active.content.slice(0, 1000) }],
        confidence: 1, uncertainties: [], sensitivity_hint: 'none' }] };
    for (const entry of ['agent', 'native']) {
      // (a) the frozen M0-C output for the fixture, with the injection as client label.
      const gold = await send[entry]({ idempotency_key: key(`e06g${entry}`), scope, client_label: injection.slice(0, 120),
        segment: input, candidates: output });
      const expectedGold = output.schema_version !== 'candidate_information.v1' ? /INSTANCE_SCHEMA_INVALID/
        : output.items.length === 0 ? /intake_no_candidates/ : null;
      if (expectedGold) {
        r.check(`06.${sec}.${entry}.gold`, `${sec} ${entry}: the frozen output is rejected by validation`, true,
          gold?.status === 'rejected' && expectedGold.test(gold?.error_code ?? ''));
      } else {
        r.check(`06.${sec}.${entry}.gold`, `${sec} ${entry}: the frozen output is stored as candidates`, 'committed',
          gold?.status);
      }
      // (b) the injection text captured verbatim as a candidate claim.
      const dataKey = key(`e06d${entry}`);
      const data = await send[entry]({ idempotency_key: dataKey, scope, segment: input, candidates: asData });
      r.check(`06.${sec}.${entry}.data`, `${sec} ${entry}: the injection text is stored as data`, 'committed', data?.status);
      if (data?.supplemental?.candidates?.[0]?.id) dataKeys[entry].push(data.supplemental.candidates[0].id);
      // (c) smuggled routing fields next to the payload.
      const smuggled = await send[entry]({ idempotency_key: key(`e06s${entry}`), scope: 'global', segment: input,
        candidates: asData, tier: 'authority', authority: 'user_explicit', target_record_id: source,
        record_type: 'decision', note: injection.slice(0, 500) });
      r.check(`06.${sec}.${entry}.smuggled`, `${sec} ${entry}: smuggled tier/authority/target/record_type are rejected`,
        true, smuggled?.status === 'rejected' && /intake_unknown_field/.test(smuggled?.error_code ?? ''));
    }
    // (d) the injection text as a knowledge assertion.
    const kp = await r.tool(B, 'clued_knowledge_propose', { idempotency_key: key('e06kp'), scope,
      rule_id: 'knowledge.cross_record_fact.v1', assertion: injection.slice(0, 2000), sources: [{ id: source, version: 1 }] },
    { extract: (b) => ({ status: b?.status, tier: b?.supplemental?.tier, authority: b?.supplemental?.authority }) });
    r.check(`06.${sec}.knowledge`, `${sec}: the assertion is stored as Candidate Knowledge (authority none)`,
      ['committed', 'knowledge', 'none'], [kp.structured?.status, kp.structured?.supplemental?.tier,
        kp.structured?.supplemental?.authority]);
  }
  // Route-fixed fields as listed through both transports.
  const nativeList = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}&limit=200`, undefined,
    { extract: (b) => ({ count: b?.candidates?.length }) });
  const rows = nativeList.body?.candidates ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shape = (row) => row && [row.tier, row.scope, row.status, row.authority, row.authoritative, row.source_kind];
  r.check('06.native_rows', 'Native data candidates: tier information, route scope, pending, authority none, native_ui',
    dataKeys.native.map(() => ['information', scope, 'pending', 'none', false, 'native_ui']),
    dataKeys.native.map((cid) => shape(byId.get(cid))));
  r.check('06.agent_rows_native_view', 'Agent data candidates: agent_binding source',
    dataKeys.agent.map(() => ['information', scope, 'pending', 'none', false, 'agent_binding']),
    dataKeys.agent.map((cid) => shape(byId.get(cid))));
  const agentList = await r.tool(B, 'clued_intake_list', { scope, limit: 200 }, { extract: (b) => ({ count: b?.candidates?.length }) });
  const agentIds = new Set((agentList.structured?.candidates ?? []).map((row) => row.id));
  r.check('06.agent_list_own', 'the Binding lists its own data candidates and none of the Native ones', [true, false],
    [dataKeys.agent.every((cid) => agentIds.has(cid)), dataKeys.native.some((cid) => agentIds.has(cid))]);
  const knowledgeList = await r.tool(B, 'clued_intake_list', { scope, tier: 'knowledge', limit: 200 },
    { extract: (b) => ({ count: b?.candidates?.length }) });
  r.check('06.knowledge_rows', 'eight pending Candidate Knowledge rows with authority none', 8,
    (knowledgeList.structured?.candidates ?? []).filter((row) => row.status === 'pending' && row.authority === 'none'
      && row.tier === 'knowledge').length);
  const egress = ctx.h.worker.egress.slice(egressStart);
  r.check('06.egress_gateway_only', 'Worker egress during E2E-06 reached only the gateway', [],
    egress.filter((row) => !row.allowed).map((row) => row.host));
  r.check('06.canonical_unchanged', 'the Canonical/MTPE/projection/currentness/carrier snapshot is unchanged', baseline,
    (await r.observe('canonical snapshot', canonicalSnapshotSql, [U.userId]))[0]);
  return {};
}
