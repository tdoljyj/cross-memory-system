-- Plugin line S3 (Cross-Host v0.2.6 §20, §41.0 S3; Owner Decisions e577beb6, bfc51984; Task 9966975d):
-- the first production READY profiles. IntegrationRuntime v0.1.8 §5.1 leaves production profiles to S3
-- ("无生产 profile（S3 定义）"); S2c seeded none.
--
-- One versioned Required Capability Profile per registered Host surface (§20: a surface that shows a
-- single "ready" must fix one). Version 1 of each asks the same thing: the connection reads Clued
-- (a session resumed through this Binding after the link) and writes it (a committed record or
-- decision Receipt through this Binding after the link). They are server-verifiable evidence only
-- (§10.8 rule shape v1). Hooks and Sub-agents are not part of any profile: H1 is class C Host
-- qualification evidence and never a READY prerequisite (§21, §24.2, G-E), so the Claude Code and
-- Cowork profiles ask no more than Chat. required_qualification is ANY: READY is a product projection
-- and is not Qualification (§20, §23); a later profile version may require QUALIFIED.
--
-- Data only: no table, function or privilege changes. A profile is read only when a caller names it
-- (clued_integration_verify kind=ready_profile, status ready_profiles).

insert into clued_private.integration_ready_profiles_v1
  (profile_id, profile_version, required_capabilities, required_qualification, evidence_rules, freshness_ttl)
select s.profile_id, 1, array['context.read', 'context.write'], 'ANY',
       '{"context.read": {"kind": "resume_after_link"},
         "context.write": {"kind": "committed_receipt_after_link",
                           "families": ["record_mutation", "decision_supersede"]}}'::jsonb,
       interval '30 days'
  from (values ('anthropic.claude.chat.continuity'),
               ('anthropic.claude.claude_code.continuity'),
               ('anthropic.claude.cowork.continuity'),
               ('openai.chatgpt.web.continuity'),
               ('openai.chatgpt.desktop.continuity'),
               ('openai.chatgpt.mobile.continuity'),
               ('openai.chatgpt.codex.continuity')) s(profile_id);
