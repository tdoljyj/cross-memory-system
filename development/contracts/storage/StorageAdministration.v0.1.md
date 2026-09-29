# Storage-only administration v0.1

Status: candidate; amendment to AccountStorageInheritance.v0.1, same Storage Task.
Baseline: 289a325332e9c4d8084550cb66194b6a28fb4f20 (PR #373).

## Purpose and authority

The deployed qualification and transition-manifest functions require the global
`platform_admin_v13` designation. Production has no such designation. Bootstrapping
it would also grant unrelated platform powers. Introduce a separate storage-only
designation for the existing verified Clued account; no new human account,
credential, device grant or ordinary Agent administration endpoint is needed.

The designation names the accountable existing subject. Possession of that user's
native session or Binding does not authorize deployment operations: the existing
database-owner, SECURITY INVOKER check and private function ACL remain mandatory.
This is an audited storage maintenance designation, not a file-operation grant.

## Exact change

1. Add private `storage_admin_v2`: singleton, existing verified subject, monotonically
   increasing version, active/revoked state, latest committed Receipt. RLS enabled;
   PUBLIC/anon/authenticated/service_role have no table or function permissions.
   The migration seeds no subject and does not modify `platform_admin_v13`.
2. Add one database-owner-only designation function with explicit designate/revoke
   actions, expected version, idempotency key and exact subject. The singleton is
   never deleted and its subject never changed: no-row -> active requires version
   0; active -> revoked and revoked -> active require exact current version and a
   new request. Both transitions increment version. Acquire the designation
   advisory lock, then its row FOR UPDATE, before any Receipt or account lock.
   A replay is permitted only while that exact committed Receipt is still the
   singleton's latest Receipt, with matching resulting state/version; a superseded
   request returns a conflict, never an old successful activation result.
   Initial designation/reactivation requires auth.users existence, verified email,
   non-anonymous status and authorization_account_v12 (not deleted or banned).
   Revocation remains possible for an unavailable account.
   Every change binds an immutable committed Owner-approval Receipt, its request
   hash, and the exact current Decision ID/version. The Decision belongs to the
   subject, has authority=user_explicit, and explicitly names that subject and
   designate/revoke action in storage-admin type fields. The Receipt must target
   that Decision and committed version. Each approval Receipt can authorize only
   one successful designation change (checked against immutable audit Events).
   A new enable therefore needs a fresh Owner approval, not a recycled decision.
   Role mutation, Event and Receipt commit together; failures roll everything back.
3. Replace the bodies of the two existing private v2 maintenance functions in a
   new migration, changing only their designation dependency and input/audit field
   from platform_admin_version to storage_admin_version. No parallel fallback.
   Both take a shared lock on the active designation, validate its exact version
   and account, and hold it through receipt commit; revocation takes the conflicting
   row lock. Old input is rejected. All source review, Evidence, digest, idempotency,
   exact-target, decision/currentness, root, expiry and immutable-history checks
   remain in place. Their replay still requires current valid maintenance authority.
4. Limit this designation's maintenance to its subject's source requests and
   connections. register/link require request.owner_id=designation.subject_id;
   qualify/revoke require the registration's original source request belongs to
   that subject; transition registration requires manifest.owner_id=subject_id.
   Technical client qualification remains shared platform metadata, never an
   account storage grant. Its Event/Receipt identifies lineage/capability and
   global_technical_effect=true; global capability revoke can affect all future
   consumers without enumerating their accounts. This singleton maintenance path
   cannot link or transition other accounts. They require their own account policy
   and a future separately qualified onboarding/link path; this change does not
   claim general multi-user onboarding is implemented.
5. Existing native account-policy cutover remains a separate Owner-session and
   fixed-issuer operation. Designation/qualification/manifest registration cannot
   switch auth_mode, activate file writing, issue admission, call Google, or clear
   unknown effects. No automatic production designation is part of migration.

## Validation and release

Independent review of this amendment precedes functional implementation. Focused
disposable PostgreSQL tests cover ACL denial (including native session of designated
subject), empty/revoked/wrong-version designation, exact-subject restrictions,
idempotency/CAS, revoke versus qualification serialization, atomic receipt failure,
and unchanged empty global platform-admin table. Reuse existing qualification and
transition fixtures, updating the designation setup and input field. Their existing
negative-source, root, history, race and rollback assertions remain mandatory.

After focused fixes, run the related database regression once across both Binding
schemas, independent code review and applicable CI. Review and release the exact
additive migration under the existing deployment authorization. Actual production
designation requires the Owner's precise approval of this storage-only scope;
until then do not seed a role, bootstrap platform-admin or enable writing.
Role revocation is the rollback; preserve designation audit, jobs, denies and fences.
