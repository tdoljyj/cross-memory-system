# M1-08 PC-002 Profile Binding + Exact Windows Requalification — Author Closeout

Binding base / accepted parent-provisioning review Head: `5afb1d5f75432bdef2c8a7b5d0a5eb603f527ff9`

Profile-binding commit: `751456ac496c017a00a67e4a91029eb90168415e`

Scope: bind only the independently reviewed PC-002 parent provisioning evidence and three reviewed live directory identities into the non-issued successor Profile, then requalify those exact Profile bytes on `DESK-W-591`. No Final Issuance, Attempt Guard creation, lifecycle/model execution, or M1-09 authority is granted or performed.

## Accepted provisioning input

- Review verdict: `PASS / M1_08_PC002_PARENT_PROVISIONING_ACCEPTABLE_FOR_PROFILE_BINDING_PREPARATION`
- Reviewed provisioning Exact Head: `5afb1d5f75432bdef2c8a7b5d0a5eb603f527ff9`
- Provisioning Receipt SHA-256: `34e0e3b3540bec04563870d54bf538b11894b59051c4e9036f23723f7225e6a9`
- Provisioning Receipt Git blob: `2726e0add313a87a004f2a71d1df186fe2404c1b`

## Exact bound successor Profile

- Path: `development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-LIFE-QWEN35-08B-PC-002.owner-root-pinned.candidate.json`
- Git blob: `17deb9bf07749488fa10fb4f6b8dab5c179e6705`
- SHA-256: `c0c9cf9d5f16ab8979893b0c5f2845864f14867a5df96b98869e0aa086a88585`
- Bytes: `43853`
- `effectful_authority_issued=false`
- `required_effectful_owner_binary_sha256=TO_BE_BOUND_AT_FINAL_ISSUANCE`
- no `owner_signature`
- no `owner_final_execution_authorization`

The same reviewed provisioning Receipt SHA-256 is bound for Guard Parent, shared evidence parent, and shared runtime-lifecycle parent because one reviewed Receipt covers the single owner-authorized provisioning operation for all three directories.

## Source remains exact and unchanged

- Source manifest SHA-256: `817bbed1b907d69a186157e2f7a8604a3c6f32841fdd5e5ef9bb0b031104dd43`
- Source tree Git SHA-1: `78413820ee6ee174535f7055b2072f6ffc2e9753`
- Contract Git blob: `5db350700e831a0423dd1e6f568d6f24f0c956ef`
- No production owner source file changed during this binding step.

## Exact Windows requalification

Host: `DESK-W-591`

Toolchain:
- `go version go1.27.1 windows/amd64`
- exact `go.exe` SHA-256: `d3ccdb604eafa6031133aefe1a3db24f0bb7362b857bc2125ac4e4c178b4b490`

Result:
- top-level tests: `72 PASS`
- subtests: `24 PASS`
- fail: `0`
- skip: `0`
- `go vet`: PASS
- qualification-scope tests: PASS
- successor Profile static binding check: PASS
- owner binary executed by build helper: `false`

Raw evidence SHA-256:
- `build-receipt.json`: `a9a95da1ea4f61c8e79250dbaaa101daf4d4ec924056dde393b0f53cf9fcf29c`
- `go-test.log`: `2d05a66486ae35cb2c231b3758549589b0f612d635b7b9abf1acc6918aab15a8`
- `python-qualification-scope.log`: `67ad9aaad495dd15dcebc6f17ede51cecdea9c562b613ad46ebe79de8ece2ddb`
- `go-vet.log`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `go-build.log`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `go-test-compile.log`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- development owner binary SHA-256: `2af7d5e5176697c181dab70e620f0035543a5655915e4087ec8229d3a6b2a510`
- Windows test binary SHA-256: `bda7770d9ed1434bcb4ae3f658385dfd16b406154abef251291dff468fcf64eb`

## Live binding recheck

Two fresh read-only identity observations used the production identity path and both passed.

- live read A SHA-256: `ee8a0e28f58646f0a63e369bc43a3bdd27e90a0b602fc526e0d190d2168b4ebf`
- live read B SHA-256: `8b37bb265e0e3e692562e9ab2e2ad54d3acf296f9af2b4db89f2db31a7ccd1c1`
- both reads are field-identical
- all three live identities match the Profile bindings
- PC-001 Guard remains SHA-256 `9e0b95cf7e8cbb16608c73318b6c39b54dd5c1b2ae26daa63e822420cbce14bb`
- PC-002 Attempt Guard remains absent
- `llama-server` pre/post count: `0 / 0`

Binding recheck report SHA-256: `2fbfdc46a3e2eb8411ffe63119952cefdfa1da63b842128e0b87bf424f7cbc1a`

## Harness-only rejected setup attempts

Before the successful qualification, two build harness placements were rejected by the reviewed qualification-scope guard:
1. nested output path: `OUTPUT_MUST_BE_NEW_DIRECT_CHILD_OF_FIXED_QUALIFICATION_ROOT`
2. source worktree placed under Qualification Root: `QUALIFICATION_PROTECTED_NAMESPACE_OVERLAP`

The first live-recheck invocation also exited before tests because the shell had not changed into the Go module directory (`go.mod file not found`). These were harness/setup errors only. No owner binary, model, server, Attempt Guard, lifecycle state, or protected ModelProgram parent was created or executed by those rejected attempts.

## Authority remains closed

- Final Issuance: not performed
- PC-002 Attempt Guard: not created
- `llama-server`: not started
- model: not loaded
- PC-002 lifecycle smoke: not executed
- M1-09: not authorized
- training / distillation / promotion / activation / release / production deployment: not authorized

Next gate: Fresh-Context independent review of the exact bound successor Profile + exact Windows requalification + live binding recheck before any Final Issuance.
