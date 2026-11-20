#!/usr/bin/env node
// A psql stand-in for production-release-door-flow-db.test.mjs: the embedded
// PostgreSQL package has no psql binary (task-goal-delivery-db.test.mjs says
// the same). The test runs the release workflow's own bash steps unchanged and
// puts a `docker` on PATH that hands everything after `postgres:17-alpine psql`
// to this file. It accepts only the psql arguments those steps use
// (<conninfo> -v NAME=VALUE -X -q -t -A -tA -c <command>...) and keeps psql's
// behaviour for them: each -c is one simple-protocol query on one session, a
// `copy ... from stdin` reads standard input, -tA prints each row's values
// joined by | as the server sent them, ON_ERROR_STOP=1 stops at the first error
// with exit status 1 and the message on standard error (VERBOSITY=terse form),
// and leaving the session rolls back an open transaction.
import pg from 'pg';

function parse(argv) {
  const options = { conninfo: null, commands: [], quiet: false, tuplesOnly: false, unaligned: false, variables: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-c') options.commands.push(argv[++i]);
    else if (arg === '-v') { const [name, ...value] = argv[++i].split('='); options.variables[name] = value.join('='); }
    else if (arg === '-X') continue;
    else if (/^-[qtA]+$/.test(arg)) {
      if (arg.includes('q')) options.quiet = true;
      if (arg.includes('t')) options.tuplesOnly = true;
      if (arg.includes('A')) options.unaligned = true;
    } else if (!arg.startsWith('-') && options.conninfo === null) options.conninfo = arg;
    else throw new Error(`psql stand-in: unsupported argument ${arg}`);
  }
  if (!options.conninfo) throw new Error('psql stand-in: no connection string');
  if (options.commands.some((command) => typeof command !== 'string')) throw new Error('psql stand-in: -c without a command');
  return options;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};

class CopyIn extends pg.Query {
  constructor(text, bytes) { super(text); this.bytes = bytes; }
  handleCopyInResponse(connection) {
    if (this.bytes.length > 0) connection.sendCopyFromChunk(this.bytes);
    connection.endCopyFrom();
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const stop = options.variables.ON_ERROR_STOP === '1';
  // Values as the server sends them (t/f, JSON text), the way psql prints them.
  const client = new pg.Client({ connectionString: options.conninfo, types: { getTypeParser: () => (value) => value } });
  try { await client.connect(); } catch (error) {
    process.stderr.write(`psql: error: connection to server failed: ${error.message}\n`);
    return 2;
  }
  let stdin = null;
  let status = 0;
  try {
    for (const command of options.commands) {
      try {
        if (/^\s*copy\b[\s\S]*\bfrom\s+stdin\b/i.test(command)) {
          stdin ??= await readStdin();
          await new Promise((resolve, reject) => {
            const copy = new CopyIn(command, stdin);
            copy.on('end', resolve); copy.on('error', reject); client.query(copy);
          });
          continue;
        }
        const results = [await client.query(command)].flat();
        for (const result of results) {
          if (Array.isArray(result.fields) && result.fields.length > 0) {
            for (const row of result.rows) {
              process.stdout.write(result.fields.map((field) => row[field.name] ?? '').join('|') + '\n');
            }
          } else if (!options.quiet && result.command) process.stdout.write(`${result.command}\n`);
        }
      } catch (error) {
        process.stderr.write(`ERROR:  ${error.message}\n`);
        status = 1;
        if (stop) break;
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return status;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
});
