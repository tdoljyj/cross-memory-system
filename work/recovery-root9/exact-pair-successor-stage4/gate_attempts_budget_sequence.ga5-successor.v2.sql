CREATE UNIQUE INDEX gate_attempts_budget_sequence_root9_ga5_successor_key
ON clued_control.gate_attempts (budget_sequence)
WHERE ga_id <> ALL (ARRAY['ga_4a88b0436cf80beeb5e194c98bb0297e'::text,'ga_dd2dc30bfc6b93ac2f30b7292dc347cc'::text]);

DROP INDEX clued_control.gate_attempts_budget_sequence_root9_successor_key;

COMMENT ON INDEX clued_control.gate_attempts_budget_sequence_root9_ga5_successor_key IS
'Preserves one attempt per budget except the two immutable Root9 predecessors; exact reserve_gate permits one execution-ready successor inheriting seq102.';
