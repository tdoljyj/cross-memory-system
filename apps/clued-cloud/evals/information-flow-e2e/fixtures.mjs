// The only harness database write path (plan section 2.1). Used exclusively
// for setup that has no product transport: v12 issuer registration, the
// E2E-13 maintenance write and Binding-row delete, and the E2E-15(b)
// Evidence re-point. Every call is recorded by the harness as a
// `db_fixture_setup` step and is never a pass observation.

import pg from 'pg';
import { identity, loopbackOrBridge } from './observer.mjs';

export async function connectFixtures(dbUrl, expected) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const id = await identity(client);
  if (expected && (id.system_identifier !== expected.system_identifier || id.database_oid !== expected.database_oid)) {
    await client.end();
    throw new Error('fixture connection reached an unexpected database');
  }
  if (!loopbackOrBridge(id.server_addr)) throw new Error(`fixture server address ${id.server_addr} is not local`);
  return {
    identity: id,
    registerIssuer: async (issuerHash, resource) => client.query(
      "insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'IF M0-D S6 harness issuer')",
      [issuerHash, resource]),
    maintenanceWrite: async (userId, input, requestHash) => (await client.query(
      'select clued_private.record_mutation_with_terminal_guard($1,null,$2,$3) v', [userId, input, requestHash])).rows[0].v,
    deleteBinding: async (bindingId) => (await client.query(
      'delete from public.clued_agent_bindings where id=$1', [bindingId])).rowCount,
    repointCandidateEvidence: async (candidateId, evidenceId) => (await client.query(
      'update clued_private.information_candidates set evidence_ids=array[$2::uuid] where id=$1',
      [candidateId, evidenceId])).rowCount,
    close: () => client.end(),
  };
}
