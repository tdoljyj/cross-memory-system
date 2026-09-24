// Read-only database observer (plan section 2.1, rule in section 3). Used
// only for internal state that has no transport read route: lineage,
// record_evidence_status, MTPE/projection/currentness heads, carriers and
// Receipt status. Every query runs in a READ ONLY transaction and every
// connection re-asserts the database identity recorded after `db reset`.

import pg from 'pg';

export async function identity(client) {
  return (await client.query(`select (select system_identifier::text from pg_control_system()) system_identifier,
    current_database() database, (select oid::text from pg_database where datname=current_database()) database_oid,
    coalesce(host(inet_server_addr()),'unix') server_addr`)).rows[0];
}

export function loopbackOrBridge(addr) {
  return addr === 'unix' || /^127\./.test(addr) || addr === '::1' || /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
    || /^192\.168\./.test(addr) || /^10\./.test(addr);
}

export async function connectObserver(dbUrl, expected) {
  const client = new pg.Client({ connectionString: dbUrl, options: '-c default_transaction_read_only=on' });
  await client.connect();
  const id = await identity(client);
  if (expected && (id.system_identifier !== expected.system_identifier || id.database_oid !== expected.database_oid)) {
    await client.end();
    throw new Error('observer connected to an unexpected database');
  }
  if (!loopbackOrBridge(id.server_addr)) throw new Error(`observer server address ${id.server_addr} is not local`);
  const query = async (sql, params = []) => {
    await client.query('begin read only');
    try {
      const result = await client.query(sql, params);
      await client.query('commit');
      return result.rows;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  };
  return { client, identity: id, query, close: () => client.end() };
}
