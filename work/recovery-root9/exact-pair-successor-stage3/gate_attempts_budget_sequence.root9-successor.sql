CREATE UNIQUE INDEX gate_attempts_budget_sequence_root9_successor_key
ON clued_control.gate_attempts (budget_sequence)
WHERE ga_id <> 'ga_4a88b0436cf80beeb5e194c98bb0297e';

ALTER TABLE clued_control.gate_attempts
DROP CONSTRAINT gate_attempts_budget_sequence_key;

COMMENT ON INDEX clued_control.gate_attempts_budget_sequence_root9_successor_key IS
'Preserves one attempt per budget except the immutable Root9 predecessor; exact-pair reserve_gate permits at most one successor inheriting seq102.';

