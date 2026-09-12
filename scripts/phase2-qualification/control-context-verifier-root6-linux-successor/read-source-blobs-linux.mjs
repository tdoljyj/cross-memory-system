// Linux batch reader for the bounded immutable source-blob set (R21-F3).
//
// verifySourcePublication -> readCompleteSourceSet -> this. The predecessor's implementation, in
// control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs, pins
// C:/Program Files/nodejs/node.exe and C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
// and spawns a PowerShell launcher. On this host it throws ENOENT on the first of those, measured.
//
// It is fail-closed, which is why it survived: nothing writes, nothing is corrupted. What makes it
// a blocker is WHEN it is first reached. Per the runbook that path runs at step 18, after step 16
// reserves the budget -- one shot, ceiling 10506 exactly equal to the post-use value -- and after
// step 17 issues the GA. The single allocation would burn on an ENOENT.
//
// The predecessor module is NOT edited: eight earlier controllers import it and pin its bytes, so
// changing it in place would break their manifests. The Linux path therefore lives here, owned by
// this controller, and reuses the predecessor's pure logic -- planRefs and validateBlob decide
// what a valid blob is, and validateBatchResponse re-validates the assembled batch. Importing that
// module is safe: its Windows paths are string constants read only inside its own functions, which
// this file never calls.
//
// What is deliberately NOT carried over: the PowerShell launcher and the child worker process.
// Those existed to run four concurrent reads behind a synchronous interface. Here the reads are
// sequential in-process, which costs wall time and removes two binaries, a launcher script and a
// worker from the trusted set. Every per-read and aggregate bound the worker enforced is enforced
// here, and the batch deadline is checked before each read rather than by a killer timer, because
// a synchronous loop cannot be interrupted by one.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {planRefs, validateBlob} from '../control-context-verifier-original-input-capacity-successor/ref-plan.mjs';
import {validateBatchResponse} from '../control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs';

const gh = '/usr/local/bin/gh';
const ghSHA = 'f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618';
const prefix = 'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const need = (v, m) => { if (!v) throw Error(m); };

// The predecessor's own limits, kept identical except concurrency, which is now 1.
export const limits = Object.freeze({
  concurrency: 1, refs: 128, request_bytes: 65536,
  blob_response_bytes: 32 * 1024 * 1024, aggregate_response_bytes: 32 * 1024 * 1024,
  per_read_ms: 10000, batch_ms: 120000,
});

export function readSourceBlobRefsBounded(refs, sizes) {
  const plan = planRefs(refs, sizes);
  need(sha(fs.readFileSync(gh)) === ghSHA, 'GITHUB_CLI_BYTES_DRIFT');
  const input = JSON.stringify({refs, expected_sizes: sizes}) + '\n';
  need(Buffer.byteLength(input) <= limits.request_bytes, 'BOUNDED_BATCH_REQUEST');

  const deadline = Date.now() + limits.batch_ms;
  const byUri = new Map();
  let aggregate = 0;
  // planRefs returns unique as [{ref, size}], deduplicated by uri -- read each distinct blob once
  // even when the caller lists it twice, which is what the predecessor's worker did too.
  for (const {ref} of plan.unique) {
    need(Date.now() < deadline, 'IMMUTABLE_BLOB_BATCH_TIMEOUT');
    const id = ref.uri.slice(prefix.length);
    need(/^[a-f0-9]{40}$/.test(id), 'EXACT_BLOB_REF_URI');
    let raw;
    try {
      raw = execFileSync(gh, ['api', '--hostname', 'github.com',
                              'repos/tdoljyj/cross-memory-system/git/blobs/' + id],
        {encoding: 'utf8', timeout: Math.min(limits.per_read_ms, deadline - Date.now()),
         maxBuffer: limits.blob_response_bytes, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (e) {
      throw Error('IMMUTABLE_BLOB_READ_FAILED:' + id.slice(0, 8) + ':' + String(e.code ?? e.message).slice(0, 60));
    }
    aggregate += Buffer.byteLength(raw);
    need(aggregate <= limits.aggregate_response_bytes, 'IMMUTABLE_BLOB_RESPONSE_LIMIT');
    byUri.set(ref.uri, JSON.parse(raw));
  }

  // Assembled in the caller's order, including any repeated ref, then handed to the predecessor's
  // validator -- which re-runs planRefs and validateBlob over every entry. Nothing here is trusted
  // on the strength of having been fetched.
  const blobs = refs.map(ref => {
    const blob = byUri.get(ref.uri);
    need(blob !== undefined, 'BLOB_MISSING_FROM_BATCH');
    return blob;
  });
  for (let i = 0; i < refs.length; i++) validateBlob(refs[i], blobs[i], sizes[i]);
  // validateBatchResponse reports concurrency: 4, hardcoded for the predecessor's worker. These
  // reads are sequential, so that field would be false about this run -- corrected here rather
  // than by editing the shared module, whose bytes eight controllers pin.
  return {...validateBatchResponse(refs, sizes,
    {state: 'EXACT_IMMUTABLE_BLOB_BATCH_READ', refs, expected_sizes: sizes, blobs}),
    concurrency: limits.concurrency, reader: 'read-source-blobs-linux.mjs'};
}
