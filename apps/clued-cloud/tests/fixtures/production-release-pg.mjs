// Local query responses for the release CLI test. Never open a connection.
import { appendFileSync, readFileSync } from 'node:fs';

let readIndex = 0;

class Client {
  constructor({ connectionString, connectionTimeoutMillis, query_timeout }) {
    this.fixture = JSON.parse(readFileSync(connectionString, 'utf8'));
    if (this.fixture.clients) {
      appendFileSync(this.fixture.clients, JSON.stringify({ connectionTimeoutMillis, query_timeout }) + '\n');
    }
  }
  async connect() {}
  async end() {}
  async query(sql) {
    if (['begin read only', 'commit', 'rollback'].includes(sql)) return {};
    if (sql.includes('supabase_migrations.schema_migrations')) return { rows: this.fixture.history };
    if (sql.includes('pg_get_functiondef')) return { rows: [{ definition: this.fixture.frontier }] };
    if (sql.includes('projection_watchdog_snapshot()')) {
      appendFileSync(this.fixture.reads, Date.now() + '\n');
      const snapshots = this.fixture.snapshots;
      return { rows: [{ snapshot: snapshots[Math.min(readIndex++, snapshots.length - 1)] }] };
    }
    throw new Error('unrecognized_fixture_query');
  }
}

export default { Client };
