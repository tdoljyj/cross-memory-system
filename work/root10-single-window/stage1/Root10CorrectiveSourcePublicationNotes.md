# Root10 trusted-entry correction

This is a corrective source publication inside the already authorized single
Root10 window. It does not issue a GA, allocate a budget, write PostgreSQL, or
declare any formal PQUAL or GRR result.

The production JavaScript template consumed a Python newline escape and produced
an invalid Python string. Correct the one escape and make its regression test
evaluate the real JavaScript template instead of partially unescaping it.

The 33-file manifest is now
`d01bd55e02614c0d2b6f51f80fe5b56816aecc2f29e753344a4bcac56aaaf559`.
Only `tool-entry.functions.js` and `selftest-runtime-pins.mjs` changed; the other
31 entries, contract, Root payload, generations, window, Gate/Profile/Scope,
fixed runtime images, original oracles, and budget/cap values remain unchanged.

Validation is recorded in `Root10CorrectedPreflightReadiness.json` (20/20 unit
checks, no formal qualification) and `Root10FinalGeneratedEntryRegression.json`
(the complete corrected entry reaches the CLI; the old escape reproduces the
SyntaxError). Both run in fixed read-only, networkless Linux containers without
a Docker socket or GA input. Three independent review artifacts approve the
corrected source, unchanged oracle applicability, and dual-publication builders.

The builders now preserve the original PR190 Root signature while separately
binding corrected controller source to this Owner publication. A subsequent P2
will contain the exact rebuilt qualification/runtime/Status29 payload. Only
after its actual Owner merge, rollback verification, preflight and expected-
current activation may the one authorized budget and one formal GA be used.

No refund, capacity increase, reassignment, second GA, or successor is introduced.
