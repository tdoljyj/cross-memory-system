'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- preloaded with `node --require` before any ESM loads */
// Information Flow M0-D S6 isolation guard (plan section 7, point 2).
// Loaded with `node --require` into every harness Node process. Every outbound
// socket, TLS connection and DNS lookup is recorded; DNS queries (resolve*,
// reverse, lookupService, callback, promises or Resolver) are refused. Only loopback TCP and
// Unix sockets are allowed; any other destination throws before a packet is
// sent. Loopback ports listed in IFE2E_DENY_PORTS (the egress proxy of the
// container, for example) are refused too, so nothing can leave through a
// local forwarder. At exit the ledger is written to IFE2E_GUARD_LEDGER.

const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const fs = require('node:fs');

const denyPorts = new Set(String(process.env.IFE2E_DENY_PORTS ?? '')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0));
const ledger = { pid: process.pid, deny_ports: [...denyPorts].sort((a, b) => a - b), argv1: require('node:path').basename(process.argv[1] ?? ''),
  allowed: {}, denied: [], dns: [] };

function loopback(host) {
  if (host === undefined || host === null || host === '') return true; // Node default host is localhost
  const value = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost' || value === '::1' || /^127\./.test(value) || value === '::ffff:127.0.0.1';
}

function record(kind, options) {
  if (options && typeof options.path === 'string') {
    ledger.allowed[`unix:${kind}`] = (ledger.allowed[`unix:${kind}`] ?? 0) + 1;
    flush();
    return;
  }
  const host = options?.host ?? options?.hostname;
  const port = Number(options?.port);
  if (!loopback(host) || denyPorts.has(port)) {
    ledger.denied.push({ kind, host: String(host ?? ''), port: Number.isFinite(port) ? port : null });
    flush();
    const error = new Error(`ife2e_isolation_violation: ${kind} to ${host}:${port}`);
    error.code = 'IFE2E_ISOLATION_VIOLATION';
    throw error;
  }
  const label = `${kind}:loopback:${port}`;
  ledger.allowed[label] = (ledger.allowed[label] ?? 0) + 1;
  // Written on every connection, so a SIGKILLed process still leaves its ledger.
  flush();
}

function normalize(args) {
  const [first, second] = args;
  if (Array.isArray(first)) return normalize(first);
  if (first && typeof first === 'object') return first;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof second === 'string' ? second : undefined };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  record('tcp', normalize(args));
  return originalConnect.apply(this, args);
};
const originalTls = tls.connect;
tls.connect = function guardedTls(...args) {
  const options = normalize(args);
  if (!options.socket) record('tls', options);
  return originalTls.apply(this, args);
};
const originalLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  ledger.dns.push(String(hostname));
  if (!loopback(hostname)) {
    ledger.denied.push({ kind: 'dns', host: String(hostname), port: null });
    flush();
    const callback = rest.find((value) => typeof value === 'function');
    const error = new Error(`ife2e_isolation_violation: dns ${hostname}`);
    error.code = 'IFE2E_ISOLATION_VIOLATION';
    if (callback) { process.nextTick(() => callback(error)); return undefined; }
    throw error;
  }
  return originalLookup.call(this, hostname, ...rest);
};

// dns.resolve*, dns.reverse and dns.lookupService (callback, promises and
// Resolver instances) send queries to the configured DNS server, which is
// egress in its own right; no harness code uses them, so every call is
// refused and recorded. dns.promises.lookup follows dns.lookup.
function dnsViolation(kind, hostname) {
  ledger.dns.push(String(hostname));
  ledger.denied.push({ kind, host: String(hostname), port: null });
  flush();
  const error = new Error(`ife2e_isolation_violation: ${kind} ${hostname}`);
  error.code = 'IFE2E_ISOLATION_VIOLATION';
  return error;
}
const QUERY_METHODS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
  'lookupService'];
function denyCallbackQueries(target) {
  for (const name of QUERY_METHODS) {
    if (typeof target[name] !== 'function') continue;
    target[name] = function guardedQuery(hostname, ...rest) {
      const error = dnsViolation(`dns:${name}`, hostname);
      const callback = rest.find((value) => typeof value === 'function');
      if (callback) { process.nextTick(() => callback(error)); return undefined; }
      throw error;
    };
  }
}
function denyPromiseQueries(target) {
  for (const name of QUERY_METHODS) {
    if (typeof target[name] !== 'function') continue;
    target[name] = function guardedQuery(hostname) {
      return Promise.reject(dnsViolation(`dns:${name}`, hostname));
    };
  }
}
denyCallbackQueries(dns);
if (typeof dns.Resolver === 'function') denyCallbackQueries(dns.Resolver.prototype);
const dnsPromises = dns.promises;
if (dnsPromises) {
  denyPromiseQueries(dnsPromises);
  if (typeof dnsPromises.Resolver === 'function') denyPromiseQueries(dnsPromises.Resolver.prototype);
  const originalPromiseLookup = dnsPromises.lookup;
  dnsPromises.lookup = function guardedPromiseLookup(hostname, ...rest) {
    ledger.dns.push(String(hostname));
    if (!loopback(hostname)) return Promise.reject(dnsViolation('dns', hostname));
    flush();
    return originalPromiseLookup.call(this, hostname, ...rest);
  };
}

function flush() {
  const target = process.env.IFE2E_GUARD_LEDGER?.replace('{pid}', String(process.pid));
  if (!target) return;
  try {
    const summary = { ...ledger, dns: [...new Set(ledger.dns)].sort() };
    fs.writeFileSync(target, `${JSON.stringify(summary)}\n`);
  } catch { /* the ledger directory may be gone during teardown */ }
}
flush();
process.on('exit', flush);
module.exports = { ledger, flush };
