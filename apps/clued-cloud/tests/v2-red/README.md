# V2 red-contract suite

Run with:

```bash
npm run test:v2:red
```

This suite reads only the repository's local migration files. It makes no database or network connection and deliberately runs separately from the green baseline suite.

During phase 3, failures are expected: they prove the accepted two-level/five-view invariants are absent from the old implementation. Phase 4 must turn these tests green with an additive migration and canonical service implementation. Do not weaken or skip an assertion merely to make the red suite pass.
