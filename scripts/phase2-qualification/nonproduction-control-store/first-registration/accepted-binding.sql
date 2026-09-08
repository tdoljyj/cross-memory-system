-- NOT EXECUTED. $1 is one fully independently accepted, actually signed configuration JSON.
-- Run only in uscrdifznmlvczcekqpw, in the SAME transaction as the first append_event.
-- Missing future acceptance/signature hashes fail NOT NULL constraints; no placeholders/defaults.
insert into clued_control.accepted_binding
select * from jsonb_to_record($1::jsonb) as b(
 root_id text, project_ref text, purpose text, environment text, subject_sha256 text,
 owner_approval_commit text, not_before timestamptz, expires_at timestamptz,
 issuer text, audience text, algorithm_config text, schema_sha256 text,
 registration_acceptance_sha256 text, store_acceptance_sha256 text,
 protocol_mapping_sha256 text, signature_evidence_sha256 text
);
-- No ON CONFLICT overwrite: a nonempty binding requires explicit reconciliation.
