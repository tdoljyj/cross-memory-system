// The only harness database write path (plan section 2.1). Used exclusively
// for setup that has no product transport: v12 issuer registration, the
// E2E-13 maintenance write and Binding-row delete, the E2E-15 (d)/(d2)
// candidate Evidence re-point, and the E2E-15 (d3) Evidence content-hash
// tamper (tamperEvidenceHash, session_replication_role=replica for one
// statement). Every call is recorded by the harness as a `db_fixture_setup`
// step and is never a pass observation.

import crypto from 'node:crypto';
import pg from 'pg';
import { identity, loopbackOrBridge } from './observer.mjs';

export async function connectFixtures(dbUrl, expected, bridgeCidrs = []) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const id = await identity(client);
  if (expected && (id.system_identifier !== expected.system_identifier || id.database_oid !== expected.database_oid)) {
    await client.end();
    throw new Error('fixture connection reached an unexpected database');
  }
  if (!loopbackOrBridge(id.server_addr, bridgeCidrs)) throw new Error(`fixture server address ${id.server_addr} is not local`);
  return {
    identity: id,
    registerIssuer: async (issuerHash, resource) => {
      await client.query('begin');
      try {
        const registered = await client.query(
          "insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'IF M0-D S6 harness issuer')",
          [issuerHash, resource]);
        // After 2b, permanent issuer provisioning creates identity only. This
        // isolated setup explicitly issues its synthetic credential generation.
        const issuer = (await client.query(
          "select id from clued_private.issuer_identities_v1 where kind='authorization' and legacy_key=$1",
          [issuerHash])).rows[0];
        if (!issuer) throw new Error('synthetic issuer identity was not provisioned');
        const verifier = 'cv1:' + crypto.createHash('sha256').update('clued.credential-verifier.v1:' + issuerHash).digest('hex');
        const generation = (await client.query(
          'select clued_private.issuer_credential_stage_v1($1,$2) generation', [issuer.id, verifier])).rows[0].generation;
        await client.query('select clued_private.issuer_credential_activate_v1($1,$2)', [issuer.id, generation]);
        await client.query('commit');
        return registered;
      } catch (error) { await client.query('rollback'); throw error; }
    },
    maintenanceWrite: async (userId, input, requestHash) => (await client.query(
      'select clued_private.record_mutation_with_terminal_guard($1,null,$2,$3) v', [userId, input, requestHash])).rows[0].v,
    deleteBinding: async (bindingId) => (await client.query(
      'delete from public.clued_agent_bindings where id=$1', [bindingId])).rowCount,
    repointCandidateEvidence: async (candidateId, evidenceId) => (await client.query(
      'update clued_private.information_candidates set evidence_ids=array[$2::uuid] where id=$1',
      [candidateId, evidenceId])).rowCount,
    // E2E-15 (d3): simulates a broken server-computed Evidence linkage after a
    // token was issued (the S3 DB-test pattern). Replica role bypasses the
    // Evidence immutability trigger for this one fixture statement.
    tamperEvidenceHash: async (evidenceId, newHash) => {
      await client.query('begin');
      try {
        await client.query('set local session_replication_role=replica');
        const count = (await client.query('update public.clued_evidence set content_hash=$2 where id=$1',
          [evidenceId, newHash])).rowCount;
        await client.query('commit');
        return count;
      } catch (error) { await client.query('rollback'); throw error; }
    },
    close: () => client.end(),
  };
}
