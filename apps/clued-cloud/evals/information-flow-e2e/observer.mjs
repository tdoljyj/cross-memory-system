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

function ipv4ToInt(addr) {
  const parts = String(addr).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function inCidr(addr, cidr) {
  const [base, bits] = String(cidr).split('/');
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base);
  const n = Number(bits);
  if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

// Local means loopback, a Unix socket, or one of the Docker bridge subnets of
// the local db container determined at runtime (never any RFC1918 address).
export function loopbackOrBridge(addr, bridgeCidrs = []) {
  return addr === 'unix' || /^127\./.test(addr) || addr === '::1'
    || bridgeCidrs.some((cidr) => inCidr(addr, cidr));
}

export async function connectObserver(dbUrl, expected, bridgeCidrs = []) {
  const client = new pg.Client({ connectionString: dbUrl, options: '-c default_transaction_read_only=on' });
  await client.connect();
  const id = await identity(client);
  if (expected && (id.system_identifier !== expected.system_identifier || id.database_oid !== expected.database_oid)) {
    await client.end();
    throw new Error('observer connected to an unexpected database');
  }
  if (!loopbackOrBridge(id.server_addr, bridgeCidrs)) {
    await client.end();
    throw new Error(`observer server address ${id.server_addr} is not local`);
  }
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
