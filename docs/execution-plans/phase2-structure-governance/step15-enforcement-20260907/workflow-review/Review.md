# Step15 CI wiring independent review

Current exact bytes PASS scoped static review; no remaining revisions. No tests or Step16/17/18 execution were performed. This scope excludes review of my earlier migration implementation.

The positive path retains the exact candidate source and one ZIP, and executes Freeze boundary, Naming, directed tests, then the original four Gates. Six positive reports and the legacy negative artifact remain distinct. All eight other workflows, including four BASE_CORE, are byte-identical to the before-boundary.

The later permission mode accepts only403 with an explicit integration permission denial. Other403 results fail. Unexpected branch creation is recorded before cleanup of exactly that new ref and always fails. Unsuccessful cleanup requires recovery from the recorded ref. Both necessary findings are fixed. This observation concerns only this contents:read credential and operation; it does not prove administrator non-bypass.

Step16 requires actual successful validate-v027 and matching source/candidate/run/attempt evidence. A green permission-mode workflow with skipped validation is not sufficient. Context JSON is not a signature or acceptance decision.

Exact bytes:

- workflow: `9a45acb955d1eee8e84491257043056eeefe8a088be6425f4b7cfa8cded0b520`
- ci_execution.py: `c316b3ef3dde4f89d2c2f23125fae15b2f959552de38cbc93d8efb1c6e375a78`
- AllowedDifferences.json: `9f79ca2b833f2f91d6b90228d6a6719ba2ddcf479e09a143b12c0f10df4fa54b`

Step17 integration: preserve BeforeBoundary unchanged. A new comparator revision must check every original before state, then use only the two listed exact reviewed successor expectations. Apply the same explicit successor rule to C15's workflow source binding, while retaining its original contract/digest. Check ci_execution.py absence at the baseline commit plus exact current bytes. Preserve all64 after states,39locks and other protected bytes/path membership checks. Bind the allowed manifest digest and root adoption in the later report. The original Step13/14 verifier and reports remain unchanged. Its strict workflow-drift failure must not be hidden by modifying the old baseline; implement the explicit reviewed successor rule in a separately identified comparator revision. No Step17 run occurred in this preparation.
