// A connection's stage-1 node that is fit to hold ci-admission (migration 20261114120000,
// clued_private.ci_admission_target_require_v1): heard just now, reporting NORMAL and a Source. Tests that mark
// ci-admission (resident-node) or hand it over by hand give the target one. heard() reports again; call it before a
// mark that comes later than the server's target_heartbeat_minutes after the last report.
import crypto from 'node:crypto';

export const FIT_SOURCE = 'a5'.repeat(32);
const hex = () => crypto.randomBytes(32).toString('hex');
const jwk = () => ({ kty: 'EC', crv: 'P-256', x: crypto.randomBytes(32).toString('base64url'), y: crypto.randomBytes(32).toString('base64url') });

export async function fitNode(admin, { userId, bindingId, projectId = null, source = FIT_SOURCE }) {
  let project = projectId;
  if (!project) {
    project = crypto.randomUUID();
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,$3,$3,$4,'confirmed',now())`, [project, userId, 'node-' + project, 'project:' + project]);
  }
  const node = (await admin.query(`insert into clued_private.ci_nodes_v1(user_id,project_id,binding_id,name,profile,profile_sha256,
    identity_public_jwk,encryption_public_jwk,identity_fingerprint,encryption_fingerprint,registration_digest,idempotency_key)
    values($1,$2,$3,'FIT-NODE','{}'::jsonb,$4,$5,$6,$7,$8,$9,$10) returning node_id`,
  [userId, project, bindingId, hex(), jwk(), jwk(), hex(), hex(), hex(), crypto.randomUUID()])).rows[0].node_id;
  const heard = () => admin.query(`insert into clued_private.ci_node_liveness_v1 as l(node_id,user_id,last_heartbeat_at,
    last_sender_binding_id,heartbeat_sequence,reported_mode,reported_probe,reported_state,reported_service_running,
    reported_snapshot_age_seconds,reported_source_sha256,readable_state,readable_at)
    values($1,$2,clock_timestamp(),$3,1,'STANDBY','not-held','NORMAL',true,5,$4,'NORMAL',clock_timestamp())
    on conflict (node_id) do update set heartbeat_previous_at=l.last_heartbeat_at,last_heartbeat_at=clock_timestamp(),
      heartbeat_sequence=l.heartbeat_sequence+1`, [node, userId, bindingId, source]);
  await heard();
  return { node, project, heard };
}
