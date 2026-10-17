# KooYomi authorization issuer provisioning

This configures a new technical issuer in the existing Supabase database. It does not migrate accounts, Bindings, Canonical data, Google credentials or the legacy issuer. `scripts/kooyumi-issuer-provision.mjs` is an offline SQL generator: it reads no environment secrets and has no Cloudflare or database transport.

Use the authenticated Cloudflare connector to check Worker `clued-cloud`: the new origin must remain inactive, the legacy origin and `OAUTH_KV` (`d7e56a5789854d42b191333d8b545a97`) must be unchanged, and no other provisioning attempt may be running. The new namespace is `84dba66392314bbf82856574f85122fc`; this procedure does not bind or alter either KV namespace.

Inside one approved connector execution, generate fresh random secret `S` and an independent random 64-hex nonsecret identity `I`. Compute `P = lowerhex(SHA256(UTF8(S)))`, then `V = "cv1:" + lowerhex(SHA256(UTF8("clued.credential-verifier.v1:" + P)))`. Require `I != P`. Put only `S` through the official Cloudflare single-secret API into `KOOYUMI_AUTHORIZATION_ISSUER_TOKEN`; never return, log or persist `S` or `P`. That PUT creates and deploys a Worker version. Do not automatically deploy latest on API errors 10214/10215. Read only allowlisted settings metadata before and after it; do not dump complete settings or read old secrets. Confirm the legacy origin/KV and inactive new origin remain unchanged.

Only after an explicitly successful PUT, save this allowlisted nonsecret recovery metadata in an operator work directory outside the committed tree:

```json
{
  "contract": "kooyumi.authorization-issuer-provision/1",
  "resource": "https://kooyumi.pixelgrav.com/mcp",
  "worker_name": "clued-cloud",
  "secret_name": "KOOYUMI_AUTHORIZATION_ISSUER_TOKEN",
  "old_kv_id": "d7e56a5789854d42b191333d8b545a97",
  "new_kv_id": "84dba66392314bbf82856574f85122fc",
  "cloudflare_secret_confirmed": true,
  "identity_key": "<I: independent 64 lowercase hex characters>",
  "verifier": "<V: cv1: followed by 64 lowercase hex characters>"
}
```

From `apps/clued-cloud`, generate the transaction and read-only verification statements:

```text
node scripts/kooyumi-issuer-provision.mjs --summary <metadata.json>
node scripts/kooyumi-issuer-provision.mjs --sql <metadata.json>
node scripts/kooyumi-issuer-provision.mjs --verify-sql <metadata.json>
```

Review and execute the transaction through the approved Supabase operator connector. `current_user` must own both stage/activate functions and must not be `anon`, `authenticated`, `service_role` or `authenticator`. A Native Owner session, API role grant or service-role key cannot substitute for that operator. The transaction verifies the installed successor and identity trigger, rejects conflicting registrations, inserts the identity, then stages and activates only its new credential. It uses a short table lock because resource is not a unique column; it grants no privileges. Read-only verification must return exactly one row with `issuer_active=true`, `total_generations=1`, `usable_credentials=1`, `expected_credential_active=true` and `identity_is_not_active_proof=true`.

After an unknown database response, run verification first. Re-running the exact same transaction with the saved metadata is a no-op only for the exact active first credential; conflicts, revocation, expiry or subsequent rotation fail closed. Never generate another secret to retry a database response, retire a legacy credential, rewrite an existing identity, or enable the new origin during recovery. If the Cloudflare PUT result is unknown, metadata was lost, or the secret may since have changed, stop: the database and its verifier cannot prove which value Cloudflare holds. The operator must reconcile that operation and authorize a fresh forward repair; do not read a secret back, blindly repeat PUT, or relabel an unknown result as confirmed.

Provisioning is not end-to-end acceptance. After operator verification, separately bind the distinct new KV and activate the new origin through the reviewed release; verify OAuth consent, same-account profile, exact resource/issuer, refresh and revocation while keeping legacy consumers operational.

Official interfaces: [Cloudflare settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/), [single-secret PUT](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/), [secret handling](https://developers.cloudflare.com/workers/configuration/secrets/).
