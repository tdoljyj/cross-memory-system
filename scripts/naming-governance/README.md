# Naming governance validator candidate

This directory provides the bounded Step 8 evidence producer. It does not issue an acceptance decision, a runtime grant, or a Step 11 Freeze.

```sh
python scripts/naming-governance/run.py \
  --bindings path/to/SourceLocators.json \
  --source-root path/to/source-root \
  --candidate-zip path/to/retained-original-candidate.zip \
  --purpose evidence \
  --report path/to/Receipt.json
```

Python 3.10+ and an existing Node runtime are sufficient. `node` in the locator selects the Node executable; use `node` for a PATH-resolved portable runtime. All ordinary source selections must resolve inside `--source-root`. The thin `run.py` adapter permits one explicit external candidate ZIP selected by the matching locator and command argument. It does not change the validator predicates. The adapter inherits the prior complete package digest; a caller binding a new external path must supply the appropriate current-byte verification evidence separately. Relative paths in portable locators/catalogs should use `/`. The existing projection generator is selected by its path and exact digest, and is invoked through `projection-check.mjs`.

The locator format is `STEP8_SOURCE_LOCATORS_ONLY`, with `authority_effect: NONE`, `inputs` mapping existing role names to `{path, kind, sha256}`, and `projection_output` selecting the generated directory. This is an execution source selection, not a replacement business registry. Preserve the original source catalogs; a portable location view may map their existing source IDs and digests to retained bytes without changing business identities or accepted source semantics.

The original consumer matrix remains the `consumers` input. The supplemental Step 6 registry is `typed_consumers`, with separate `typed_authorization`, `typed_receipts`, and `step6_sources` inputs. The projection's current consumer selector can choose the exact original or supplemental consumer source. Source references use the existing source IDs, digests, and pointers. Do not rewrite the original matrix's aggregate nulls or mint global Domain/Program/Stage IDs merely to populate them.

Exit 0 means the selected bounded checks succeeded. Exit 1 carries the actual failing rule codes in the receipt. `--purpose freeze` additionally rejects unresolved core binding prerequisites; it still cannot issue Freeze. The receipt always records `formal_step8_gate: false` and `freeze_ready: false` so a local candidate check cannot impersonate an acceptance decision.

To reproduce the established controls with isolated files:

```sh
python tests/test_naming_governance_validator.py \
  --bindings path/to/SourceLocators.json \
  --source-root path/to/source-root \
  --output-root path/to/source-root/isolated-step8-run \
  --candidate-zip path/to/retained-original-candidate.zip \
  --node node
```

The output directory must be an isolated child of the declared source root. The driver reconstructs the existing 13 bounded positive types and 16 baseline negative cases from selected input bytes plus minimal mutations. It writes raw subprocess stdout/stderr, receipts, and `TestResults.json`. It does not require a checked-in fixture tree. Importing the test module without explicit source selection skips these environment-bound tests.

Use `--test-method <existing_method_name>` to check only an affected existing case. With the final accepted projection source selection, the synthetic alias positive case explicitly remains pending and does not reuse an acceptance of different alias bytes. Unchanged source files retain their original exact bytes; the driver only serializes files it actually mutates.

Preserve previous run evidence as one exact archive plus its digest/member index. Do not copy the generated fixture directories into Git. When only paths or selected projection sources change, reuse unchanged rule/negative evidence by exact code and input scope, and execute the newly selected input check. A changed validation predicate requires its corresponding controls to run again.
