// The one file in the repository that loads embedded PostgreSQL (task 11092b8b).
//
// A test builds its cluster here and starts it with startCluster in
// ./cluster-cleanup.mjs, which picks the port at start and picks again when the
// postmaster finds it taken. A port chosen before start is only free until
// something else binds it, so a cluster is never built with one.
// pg-cluster-source.test.mjs keeps every other file from loading the package.
import EmbeddedPostgres from 'embedded-postgres';
import { EPHEMERAL_INITDB_FLAGS, EPHEMERAL_POSTGRES_FLAGS } from './cluster-cleanup.mjs';

export function newCluster(options = {}) {
  if (Object.hasOwn(options, 'port')) {
    throw new Error('端口由 startCluster 选：newCluster 不收 port，启动后从 server.options.port 读');
  }
  // Every cluster is a throwaway one, so the ephemeral settings come first whether or not the caller passes any;
  // the caller's own items follow (ephemeral-postgres-flags-source.test.mjs checks them at the call site).
  // Listen on 127.0.0.1 only: a port held on one address family alone would otherwise leave the
  // postmaster up on the other and the test talking to whoever holds this one. The last setting wins.
  return new EmbeddedPostgres({
    ...options,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS, ...(options.initdbFlags ?? [])],
    postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, ...(options.postgresFlags ?? []), '-c', 'listen_addresses=127.0.0.1'],
  });
}
