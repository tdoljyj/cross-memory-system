# Kooyumi CI check names

This source change renames three check contexts. Installing the source and
updating GitHub's required-check settings are separate steps; this document is
not evidence that the live rules have changed.

| Previous check | New check | Required GitHub integration |
| --- | --- | --- |
| `clued-work-admission` | `kooyumi-work-admission` | GitHub Actions, App `15368` |
| `clued-admission-verified` | `kooyumi-admission-verified` | `clued-admission`, App `5164952` |
| `clued-merge-slot` | `kooyumi-merge-slot` | `clued-admission`, App `5164952` |

The trusted emitter is `scripts/ci/clued-work-admission.mjs`, run from the
default branch by the admission, re-verification and merge-slot workflows.
Its App installation token posts the last two checks through GitHub's Checks
API. No separate Worker or App-server deployment is needed for these names.

The admission workflow's display name and its job's display name both become
`kooyumi-work-admission`; the merge-slot workflow's `workflow_run` subscription
changes with them. Keep the workflow filename `clued-work-admission.yml`,
the job ID `clued-work-admission`, App identity, environment and secret names,
Claim trailers, RPC names, task IDs and queue references. Runner hooks locate
admission by workflow filename, so this display-only change needs no hook
installation.

Current gates, the merge-slot barrier and executor require the new contexts
with the same App, head and PR checks. Historical Owner Grant evidence may
use either admission name, followed by the existing live Grant revalidation.
The handover revoker drains both generations of App checks. Read-only R9
history uses each verified source version's names and complete byte pins;
old artifact descriptor digests remain unchanged. Frozen qualification
evidence, execution profiles and receipts are not rewritten.

For the Owner-authorized cutover, merge the coordinated emitter/consumer
change while only the three named required contexts are temporarily removed.
Retain every other rule and required check. Immediately restore the three
required contexts under their Kooyumi names after the merge; an unsuccessful
merge restores their original names. An existing run still has its original
workflow display name; obtain a new event on each relevant current PR head
after the merge and verify the new names and integration IDs. A missing new
check continues blocking merges while that verification runs.
Do not require both
generations, or change the admission state, Claim checks or Owner Grant gate.
