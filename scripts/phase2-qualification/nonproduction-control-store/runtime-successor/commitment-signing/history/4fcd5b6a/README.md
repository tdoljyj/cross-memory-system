# Fixed dynamic signature commitment candidate

Prepared for independent review; no GraphQL mutation, signature observation, GA, GRR or qualification execution occurred. The four local tests use synthetic API observations and do not verify a real signature.

The original Owner PR-merge algorithm and immutable accepted_binding remain unchanged. This proposes a distinct single-parent algorithm for the same tdoljyj Owner, web-flow signing service, isolated qualification audience and GATE_AUTHORIZATION / GATE_RESULT purposes. Ordinary source changes remain Codex-authored and use the existing PR/CI path. A dynamic authority proof must report its actual Owner author and Codex execution provenance separately.

Primary API source: https://docs.github.com/en/graphql/reference/commits (createCommitOnBranch, Authorship, Commit Signing and CreateCommitOnBranchInput). The API uses refName and required expectedHeadOid. Automatic signing is conditional on GitHub support; a successful mutation alone is insufficient. The verifier requires actual valid signature evidence, exact Owner/service, one parent, one added fixed path and immutable raw-content readback.

The fixed private auxiliary branch stores only a historical commitment to complete exact live bytes, their type/id, unique proposed private SQL URI, purpose, Audience, schema and root generation. No live payload or current revocation projection enters Git. A stable same-domain signature proof URI is included in the complete payload hash; no signature field or payload byte is excluded. The exact proof URI mapping and private proof persistence require an accepted implementation successor before use. Existing Root URI mapping is not silently extended.

The module only constructs a fixed mutation and verifies independently fetched observations. It cannot submit or retry it. The host must reserve the one signature attempt in the existing decision/attempt state, preserve an exclusive local ticket before mutation, and retain UNKNOWN after timeout or a lost response. A retry must inspect already-created immutable objects, never generate a replacement signature or overwrite the fixed path. After signing, a fresh SQL check still decides current authority; the verifier output has authority_effect NONE.

Acceptance decision required: whether this same-identity/purpose signature-channel concretization can be bound by an accepted usage/configuration successor to the current Root generation, or requires a forward generation registration because the existing exact issuer configuration binds the old algorithm. Neither choice is pre-decided here; no old metadata, key, generation or algorithm name is changed. Static Gate applicability, controller acceptance and live budget/STOP/currentness requirements remain separate.

Run only local checks: `node --test scripts/phase2-qualification/nonproduction-control-store/runtime-successor/commitment-signing/signing.test.mjs`.
