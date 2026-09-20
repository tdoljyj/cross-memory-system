# M1-08 MAJOR-07/08 r3 author remediation closeout

Source Freeze: 37bee117aaba72a088b6a2379d4daa2a93c2bce7
Repair Base: 02384f219c3dddc027dd39640a313657286df197
Intermediate r2: 3991a79f589ecd258b4339aac4f3f4843c3ddb37

Role: AUTHOR / MODIFIER. This is not Fresh-Context independent acceptance.
MAJOR-07/08 are proposed for independent closure, not governance-marked CLOSED.

MAJOR-07: only authorized evidence outputs; no TerminalFailure.json. Failure finalization uses a fixed typed terminal event, real handle identities and content hashes, live Current JSON/hash, remaining creation ledger reconciliation and owned-process state. Unknown, missing, aliased or unreadable state makes complete=false with an explicit error. Traversal is bounded and never adopts unknown objects or follows reparse points. Observation is sequential, pre-terminal-append, not atomic or continuous.
MAJOR-08: normal evidence checks limits at entry, after serialization, immediately before native open, after native handle validation and after write/sync. Normal evidence cannot spend the forensic reserve. Terminal output requires a live finalizer frame and a cause; no generic filename/payload helper remains. A finalized context cannot resume lifecycle effects. Owned-process safety cleanup remains possible after expiry.

Both Windows builds used the pinned Go 1.27.1 windows/amd64 archive, extracted toolchain tree and exact go/compile/link identities. Per run: 59 top-level PASS, 21 subtest PASS, 12 Windows-native top-level PASS, 0 FAIL, 0 SKIP; Python 10 PASS; go vet exit 0. Counts are not added across runs and native cases are a subset of top-level cases.
Owner and test binary files were rehashed on DESK-W-591 after both builds; actual bytes matched both receipts and each other. Owner binary was built, not executed. Only non-model fixture tests executed.

Native reparse fixture: NTFS_DIRECTORY_JUNCTION. Symlink-specific creation was NOT executed because the client lacked the required privilege. Do not relabel junction as symlink coverage.
PRE/POST observations show zero llama-server/18088 listeners and absent real Guard/runtime/evidence at those two timestamps only. No continuous host-wide no-effect claim.

The r2 3991 build is historical only; its passing test counts do not close its incomplete live-forensic design. r3 supersedes it without changing frozen Contract/Profile, issuer root, Current/recovery graph, launch envelope or build helper.
No final issuance, issuer-root decision, Guard Parent provisioning, Owner/model execution, merge, release or production authority is granted. Next action is independent exact-head re-review; Pre-Issuance Owner Root Decision and Guard Parent Preparation remain gated by its acceptance.
