# Repository Artifact Retention Contract v0.1

Status: **OWNER-APPROVED FORWARD POLICY**  
Scope: new repository artifacts and future cleanup decisions  
Authority effect: repository storage/placement only. This contract performs no retroactive deletion.

## Principle

Git is the development and release control plane, not the default warehouse for every raw execution byte. Evidence required to reproduce, audit or enforce a contract may remain in Git; opaque bulk payloads should not accumulate merely because they were produced during a run.

## Keep in Git

Keep files when at least one of these is true:

- source, schema, migration, contract, test, fixture or validator requires the exact path;
- a small machine-readable Receipt/Manifest/index/hash is needed for independent verification;
- the bytes are a required regression fixture and cannot be reconstructed from a stable external object;
- an immutable published repository snapshot contract explicitly requires the bytes.

## Externalize by default

Opaque ZIPs, large raw captures and duplicated source bundles should normally live in a versioned external artifact surface such as a GitHub Release asset or governed object storage. Google Drive remains appropriate for long-form human documents according to the repository/document boundary.

For new opaque/binary artifacts larger than **2 MiB**, require an explicit reason to keep the raw bytes in Git. Otherwise keep a small locator containing:

- artifact identity/name;
- byte size;
- SHA-256;
- immutable external locator/release asset identity;
- producing commit/run;
- retention/availability expectation.

The 2 MiB threshold is a review trigger, not permission to delete existing evidence.

## `artifacts/`

`artifacts/` stores bounded, machine-verifiable evidence and published snapshot material. It must not become a second Current Truth or a dumping ground for unbounded run output. Prefer Manifest/Receipt/hash over repeated raw source copies.

## `work/`

`work/` is non-authoritative implementation staging. New tracked content must be bounded to an active engineering purpose. At closeout:

- reusable implementation moves to source/`development/`/`scripts/`;
- durable evidence moves to `artifacts/`;
- narrative material follows the Drive boundary;
- disposable intermediates are not committed.

No file under `work/` may be cited as Current Truth solely because it remains on `main`.

## Cleanup safety

Existing artifacts are removed only after proving they have no live fixed-path consumer, contract/test dependency, rollback/audit duty or required historical role. Large size or age alone is not a deletion criterion.
