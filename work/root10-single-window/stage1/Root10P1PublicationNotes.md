# Root10 single-window publication P1

This publication contains the exact Root10 authorization signing payload, purpose-separated issuer metadata, independently authored Root review, scoped controller sources, and the already-tested one-time GA6 closure transaction. Publication does not register Root10, allocate a budget, issue a GA, or claim formal qualification.

The user explicitly authorized one new generation/window and subsequently relaxed the capacity ceiling. The maximum incremental allocation is 600 seconds and 134217728 evidence bytes. Historical counters remain intact: 11706 cumulative seconds and 2604247987 cumulative evidence bytes; maximum series allocations is 11. No refund, reset, budget reassignment, automatic retry, or successor after formal failure is permitted. Gate, Profile, Scope, and runner/credential/session generations are unchanged.

The existing expired, never-started GA6 can be closed BLOCKED only through the exact expected-current transaction at sequence 110. The transaction restores the original execution transition function and all security metadata before commit. Its actual rollback reached the expected sequence 112 and a separate live read verified that rollback retained sequence 110 and the original cumulative charges.

Root10 uses one bounded 600-second authorization lifetime, including the existing early-stop cleanup margin and timely GRR. It does not require the runner to consume all 600 seconds before starting GRR. The unchanged accepted formal suite contains 19 tests (PQUAL-01 through PQUAL-17, PQUAL-19 and PQUAL-20); the PQUAL-18 negative admission guard is not a twentieth formal result. Unit/readiness checks never constitute formal PQUAL or GRR PASS.

After this Owner merge, P2 will publish the exact signed Root10 proof, controller qualification, runtime acceptance, Status29 signing payload and bounded activation materials. Only after signature verification, full rollback, independent review and expected-current CAS may one new budget be allocated. Only after same-source readiness may the sole formal GA be signed. There is no P3 authorization expansion and no automatic successor.
