#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

# P10 supersession probe: a newer PR commit must cancel stale validation runs.

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"

HOSTED_ONLY_ALLOWLIST = {
    "clued-currentness-post-deploy-attestation.yml": (
        "Owner-triggered post-deploy verification uses a clean Ubuntu worker with the ICU runtime and an isolated production database secret."
    ),
    "clued-cloud-production-release.yml": (
        "Owner-dispatched production release uses a clean Ubuntu worker with ICU and isolated database and Cloudflare deployment credentials; it does not run on pull requests."
    ),
    "clued-storage-executor-window.yml": (
        "Owner-dispatched Storage executor gate (on until closed, a five-minute window, or close) uses a clean Ubuntu worker with the isolated Cloudflare deployment credential; it does not run on pull requests or check out code."
    ),
    "clued-storage-read-config.yml": (
        "Owner-dispatched Storage read key provisioning and read-flag switch uses a clean Ubuntu worker with the isolated Cloudflare deployment credential; it does not run on pull requests or check out code."
    ),
    "clued-integration-runtime-config.yml": (
        "Owner-dispatched Integration Runtime flag switch (enable after a read-only check of the production grants, or disable) uses a clean Ubuntu worker with the isolated Cloudflare deployment credential and attestation database URL; it does not run on pull requests or check out code."
    ),
    "clued-information-flow-prod-e2e.yml": (
        "Owner-dispatched production E2E reaches the public Worker with a dedicated test account; it holds no database or deployment credential and does not run on pull requests."
    ),
    "clued-ci-health.yml": (
        "The lightweight monitor must remain independent of the self-hosted pool so it can detect complete Windows/Linux capability-pool loss."
    ),
    "clued-work-admission.yml": (
        "Work Claim Admission L0a: an unfiltered required check that makes one Clued call per pull request and must not wait on self-hosted capacity; it runs base-branch code only (pull_request_target), installs no application dependencies and executes no PR code."
    ),
    "clued-work-admission-dispatch.yml": (
        "Work Claim Admission hand-dispatch check: verifies a claim before a heavy workflow is dispatched; default-branch code only, one Clued call, no application dependency install, no pull request trigger."
    ),
    "clued-work-admission-reverify.yml": (
        "Work Claim Admission hourly re-verification: re-runs a passing admission check whose claim expired or moved; default-branch code only, no application dependency install, no pull request trigger."
    ),
    "clued-merge-slot-ci.yml": (
        "Merge Admission step 3: reports the CI state of the pull requests holding a merge slot to Clued when a pull request's CI run completes, then executes the merge queue head in the same trusted job; default-branch code only, seconds of work, no application dependency install, no pull request trigger."
    ),
    "clued-merge-executor.yml": (
        "Merge Admission step 5: the independent workflow reports CI before bringing the default branch into the merge queue head and turning on auto-merge or merging it as the clued-admission App, on main push and by hand; the slot report invokes the same executor script inline under the shared job lock; default-branch code only, seconds of work, no application dependency install, no pull request trigger."
    ),
    "contract-placement.yml": (
        "Owner Decision 6a66d2fd: unfiltered required placement and actual public-bootstrap budget check on ubuntu-latest; no secrets or application dependency tree, no self-hosted PR execution, five-minute timeout."
    ),
    "clued-ci-usage-report.yml": (
        "Merge Admission §12.1 CI usage measurement: a daily and hand-dispatched read-only report under a 2,000-request budget with the measurement-only read-only App's installation token (200 with the GITHUB_TOKEN fallback; Owner Decision 00b71629), its ID and key only from the main-only clued-admission environment; default-branch code only, no application dependency install, no pull request trigger, and it must not take the self-hosted capacity it measures."
    ),
    "clued-release-tags.yml": (
        "Release tagging (Task 6dfd7560): creates the VERSION and release/<date>-r<run> tags after a VERSION change on main or a successful production deploy; default-branch code only, no application dependency install, no pull request trigger."
    ),
}

CONCURRENCY_EXEMPTIONS = {
    "model-program-m0.yml": (
        "M0 SHA256SUMS binds this workflow as an exact candidate input; changing its bytes invalidates the formal M0 manifest."
    ),
}

# Owner Decision 9eb313f8: new execution uses self-hosted machines only.
# Historical explanations above are documentation, never execution permits.
# These exact existing hosted jobs are migration debt, not a renewable allowlist.
# For each migration/delete, remove that job's debt entry in the SAME change;
# delete its workflow entry when empty. A stale entry fails even after migration,
# so deleting a job and later restoring its old name cannot revive hosted usage.
# Never regenerate this baseline wholesale. A reviewed necessary bug fix names
# and updates only its exact old/new job hash; triggers/permissions stay frozen.
LEGACY_HOSTED_DEBT_SOURCE = "062543d943b65be1a88baed653f7999f25649668"
LEGACY_HOSTED_DEBT = {
    "active-doc-links.yml": {
        "control_sha256": "7634659bcf105f4af2477f7027cfe851c421457b5ccd425826bb75271ed554fc",
        "jobs": {
            "links-untrusted-hosted": "9243db8b4e05e66f46d25626efc278147b8fcaa78b3e268d4ea72f2f05dbd70d"
        }
    },
    "clued-capture-guard.yml": {
        "control_sha256": "4e84387189a85632fb502f38eb19a881c6b293750bf32ad9e57a0dd69345fc2a",
        "jobs": {
            "untrusted-hosted": "657a38474657ab293f1eacc160473fa97351453690c422d60585fda6ce0d9ed6"
        }
    },
    "clued-ci-health.yml": {
        "control_sha256": "dc029a094415fa75df866e17c6cdbfbf1ee4615d4dd2f06bf4bd9ea0ce654a7e",
        "jobs": {
            "deterministic-health-check": "3021fc047cdd2e92cc24c82ff6474a8927bda39401a82bde646d99165b232f74"
        }
    },
    "clued-ci-usage-report.yml": {
        "control_sha256": "ed91c4fd6557a88bb954c6ad4eaf3976260e9123c2b9db941ca2f0356280f687",
        "jobs": {
            "report": "6ac8b9c3992c74fa06e8bb3ba1f01206dec58d79e3d8d8b86875961b0ed3fe64"
        }
    },
    "clued-cloud-node22-install.yml": {
        "control_sha256": "020729aefbd20d07fb1f9fd469a42e0c08c5fdd76c5673eeadcfc69654a6cc01",
        "jobs": {
            "untrusted-hosted": "f9c084c82de1ab02bcfff451680b9f562385dba67ea4b53bd1b1b3645029a978"
        }
    },
    "clued-cloud-production-release.yml": {
        # PR #1121 (Fable 1121 rework): release takes no migrations and gains the rollback_drill input.
        "control_sha256": "c9cd44da8c145047a0f9bb940c079f81d4f6b0e77daa9e61bd28a416e4d20f9c",
        "jobs": {
            # PR #1121 after Fable 1121 §6 on top of release door v1 (FABLE-release-identity-autonomous-20261119):
            # one-approval release without migrations or wrangler config changes, Worker rollback judged by
            # one final reading, G6 after the rollback step; the grant goes through the database login door.
            # main job da0654044b1ffd68e72ca867a3a8fe462583c2b9caa0cde7205269f77a829fcc, routing unchanged.
            # Review after main: the 165-minute job timeout only for deploy and release (others keep 45),
            # and no rollback before the first deploy step ran.
            "release": "fd4f674e1e1f17d6b38dd4ef8b2abe5bee32f41a2d39f45a9794920b1fb20b84"
        }
    },
    "clued-currentness-post-deploy-attestation.yml": {
        "control_sha256": "3e5d2cc28b9b03d5a806d76ef8c80175ccbc502da0d6a5ca733c62482fcfb491",
        "jobs": {
            "verify-and-attest": "e0a688288499912e2827283a5f0551ef8de109f5dfc5303b054a55ce852d601f"
        }
    },
    "clued-g4-database.yml": {
        "control_sha256": "87a8650c72f07b769f3b01c699364897eccd68658928ee3f3e6d3534a15a98a7",
        "jobs": {
            # Same exact image pin and coverage test: inspect both caches before
            # network pulls. No trigger, permission, timeout or runner expansion.
            "database-gate-untrusted-hosted": "43e37eafc1de5b3fb8213484a85210a72941105bbeebf7679fd64d49623f8c8c"
        }
    },
    "clued-information-flow-prod-e2e.yml": {
        "control_sha256": "96fc9ec774d4036aa6b6f193ee8fd018bdf21cea202abb19bbb1fe5aed824ffc",
        "jobs": {
            "prod-e2e": "2fa9c38cc009657327bc8abd5197867c5985f692baf5083c6ec0169def092a86"
        }
    },
    "clued-integration-runtime-config.yml": {
        "control_sha256": "60cb97eee0f4626df176349b1b82fc6ef4fc9f15558cb0ffeb10a49f17396114",
        "jobs": {
            "configure": "e3e3db055cdff88f387a25a8d582657062a3a87c88dc3e201ac6507b10962e4f"
        }
    },
    "clued-merge-executor.yml": {
        "control_sha256": "ef6ffaeae06adbf1447fe0a74ec7e1673fc23086cdeee48cc8190a3bc9c23448",
        "jobs": {
            "execute": "ac99c44e211fb38f6843ea3d1fa345721843dcb34cfecfd1d3c3a709ba0988d8"
        }
    },
    "clued-merge-slot-ci.yml": {
        "control_sha256": "500da29fb3c1fbe9df2be795e84f92908249a8ee057bef709e17e5aa7c5e341f",
        "jobs": {
            "report": "13d032eddeef15d56c9b98d7e74cc09325e6b40fbbe190820bd9aa86a2f41089"
        }
    },
    "clued-release-tags.yml": {
        "control_sha256": "9b7e2644922cb6ae03d647fdc39b22a80c266a5d3e52856798085539448b5f6c",
        "jobs": {
            "tag": "ad92b07a5be4301e0b66c2d6fabc2721a40836453ab3d2e9899ba96c7d60600c"
        }
    },
    "clued-storage-executor-window.yml": {
        "control_sha256": "a850514ebf24062b46e80cda78e360f86133433ff3b4f69cd49651d828718ad3",
        "jobs": {
            "open-window": "9a31d618435274bf03b1e1f124c2dced55fe6b2e4cf3bda248b357d9722fb45a",
            "open": "91ae039261c9b2e3859197c2e7ecdd46e2ff43b7dd4a33f60f7f567da4192893",
            "close": "7c62fb1eca30e411c7574d80b0c7b941297f5c1d64b097d3ae226b4d5fce23ac"
        }
    },
    "clued-storage-read-config.yml": {
        "control_sha256": "946abfede4bad3c8ae99113b5086e602ae997bc3aff6b0e670993d0e0801cc1e",
        "jobs": {
            "configure": "3eae19b64efda785730509f28bcdd5752a16721f8d2b5eedeb38fa50d3a7375a"
        }
    },
    "clued-work-admission-dispatch.yml": {
        "control_sha256": "98f3b847549d76ff13d9d0db3ddad80dffb14f8a307b66f7ee06b87788780850",
        "jobs": {
            "admit": "fc0a420fe04b4df0e0fdf17101b5b0ef07e0d439f5fbed0500bf6fca73590388"
        }
    },
    "clued-work-admission-reverify.yml": {
        "control_sha256": "82d8df5d5125990053d96d3a652f882dc8ede64571401c115ceb2b4604a72513",
        "jobs": {
            "reverify": "6a903142743c660342678c05237cdeef7861690e6420165e71d389113e1c5be7"
        }
    },
    "clued-work-admission.yml": {
        "control_sha256": "9bf3b9cf078d23ce146d270a358420115aaa07c6168687a4a46b396c5e61e0b6",
        "jobs": {
            "clued-work-admission": "b795f016292cfa7196a479757fa11b2f612ca78d26e07542a7aa335e3559308a",
            "clued-work-adopt": "f1858367bf28b2ffb092c8fdfd83c138a0b8a374eb194ad349b439f0c125df5f"
        }
    },
    "design-refs.yml": {
        "control_sha256": "0791693c1c18971f9b2fc536cabce28d8d69fb6654130946648b3c82bdcaab2c",
        "jobs": {
            "design-refs-untrusted-hosted": "5639d9ad5c5f6181caa118e9c55c6f370b55f442447f9e0685976870eb8ac8d2"
        }
    },
    "information-flow-e2e.yml": {
        "control_sha256": "b371b0f90a477bf7168fc0742d268300e203eef5c6253154f45969995f6059bc",
        "jobs": {
            "e2e-untrusted-hosted": "8d8a3ab34146ff5d1dce2c66a6919b5c6f74207121726c4408e8b6009648d9eb"
        }
    },
    "memory-publication-gate.yml": {
        "control_sha256": "b268b3d9eaf338e5b21844fa880ce6798d4447cb2bb08b18fc1db33fd86649d3",
        "jobs": {
            "untrusted-hosted": "857932fb1712267e116dbe02552fa7242aa1aeedbfee8a758e2ea385cd9a7942"
        }
    },
    "model-program-m0.yml": {
        "control_sha256": "db60f42f44c269aeb91702694f3a11ae2e49a92c6c8739e55887028ea842341a",
        "jobs": {
            "validate-untrusted-hosted": "772a3eb010a62b889d18be7da42b7977415ab9f12d7799199e1700384fc711bc"
        }
    },
    "model-program-m1-entry.yml": {
        "control_sha256": "ff9bfc2d5d6f17c24c43df171cbdb2d4f1a670eabffc434ba0e71b02b25baf0d",
        "jobs": {
            "validate-untrusted-hosted": "1e35ba7c3040ca729c2e4612cc9eab04c3bc6027af92dd322a848b6077b48394"
        }
    },
    "model-program-m1-harness.yml": {
        "control_sha256": "0048735a8017e345c755fcb18dbb469d4224063c049062bcf473bb4e1ba56bc4",
        "jobs": {
            "validate-untrusted-hosted": "49e277ffb578d1d662a5e240dbb56e22189cee7e4f9c4d9de763dde672d03dc7"
        }
    },
    "model-program-m1-package.yml": {
        "control_sha256": "4669434ea23dca2c32c456496dd8cbb33caf7e8402117b217e24b4f14fd9b31b",
        "jobs": {
            "validate-untrusted-hosted": "306e9ad3c4d0f9a5c337c2463af26cdd211ba92f36dc128805bc2317236c7431"
        }
    },
    "model-program-m2-scoped-consumer.yml": {
        "control_sha256": "44b1a8e6de7369071ffa95349f2347bd0fe704334664c947dff58169b5f3613c",
        "jobs": {
            "untrusted-linux": "55c967ce7b401611df6e2673dbf78a4ff883d0d377a52c9e1cb9bc6edc1603fd"
        }
    },
    "multitrack-governance-projection.yml": {
        "control_sha256": "d100a704d9d1545c0e1e8c78e46997ed0da992c344efa41c2a3afe1d13626f6a",
        "jobs": {
            "validate-untrusted-hosted": "be5115297f448fc75299797d3d94e1e82786980a37f6cbc218283baf8736a868"
        }
    },
    "node-profile-policy.yml": {
        "control_sha256": "0ca920fd6f73e76ef6b1b17c21e18d12f2ad6ac78b3fb4c629b58944af461808",
        "jobs": {
            "untrusted-hosted": "e6b8787973d2f48fcb4435b55bb136bfd8a627602acc575dcce25d680bd43452"
        }
    },
    "public-mcp-behavior.yml": {
        "control_sha256": "3cfab33876aec48f8421f98267a400b02f6f7cf7766680aa9627d82dfa2ad344",
        "jobs": {
            "untrusted-hosted": "c8abc2a96948c6f4552e7578aa0bb24565da47aeb3c562db478b725048c20d4e"
        }
    },
    "public-mcp-protocol.yml": {
        "control_sha256": "64e5fdc0e4689afba1dd8fcea722c87464f9b9a990edfc05ccd82bb0c2874a27",
        "jobs": {
            "untrusted-hosted": "8f3caece0a4eaa6eda10802811fc19c074acb2210aeae7000190dd41c0921104"
        }
    },
}

# Owner Decision 325717a6: the gitleaks, trivy and contract-placement work may
# run on GitHub-hosted runners with free Actions minutes under the Owner's $0
# Actions budget cap. Owner Decision 22b0e0ed: these hosted jobs are executors
# only. App 5368905 stays the one publisher of the six required checks; the
# independent CI relays a hosted run it can verify (the final step emits a
# GitHub OIDC identity) and otherwise runs its formal local role, with no
# monthly ruleset switching. Owner Decision bc6fdad1: GitHub counts every check
# run with a required check's name, whatever its integration, so no job here
# is named like a required check. This is the one exception to the
# self-hosted-only rule above: exactly these executors and the admission-gate
# each of them needs, pinned like legacy debt (workflow controls and job
# bytes). It is not an allowlist: no other workflow or job, and no change to
# these bytes, is admitted, and an entry fails once its job leaves hosted
# runners or is gone.
OWNER_DECISION_HOSTED_SOURCE = "325717a6"
# Explicit candidate successor for the two existing executor jobs only. No new
# runner, trigger, timeout, billable store or job is added; push execution is
# narrowed to PRs. Three read permissions let the fresh OIDC/Native start door
# verify actual job/check/PR facts. Exact protected-head Grant is still required
# before merging this Source; this table never activates hosted execution.
HOSTED_SCAN_START_SUCCESSOR = {
    "decision": "41ab823a",
    "frozen_commit": "956078fcec98844ab9be05e857fe4f53b3372fc4",
    "previous_pins": {
        "gitleaks.yml": ["f775a27a4bf06fcff10caf74239c90bd6191fb58e59fcfb67f7141430a35e64b", "c3f023b3f2c312fe54a57394dda161d3fa4ad1e6042f5cdcc758e129830a1d7c"],
        "trivy.yml": ["57f4d26e932037446cc510595b1ba72b819b9b045a4310a589becd2b1686c6f9", "658cfd509399200a62f4493f4830abf1426b5457fd11a9788ec67c8991f2c71e"],
    },
}
OWNER_DECISION_HOSTED_JOBS = {
    "contract-placement.yml": {
        "control_sha256": "9043db3a2c533c54ac60804a543c80ae79f062109d3322e60b58eb50b749542d",
        "jobs": {
            "admission-gate": "52b78b693b432e996505e18a415bb66bc937f0cd04ae69abf336c868d38591d2",
            "contract-placement": "59ae7ed2ee75cbddf7aa192ec0f4917d049ed6eb624e33c16673be82ed449931"
        }
    },
    "gitleaks.yml": {
        "control_sha256": "f5b93595feb30ef1f9bf436fce82a08e07e0559ea706bc6af60f26c01483f301",
        "jobs": {
            "admission-gate": "52b78b693b432e996505e18a415bb66bc937f0cd04ae69abf336c868d38591d2",
            "gitleaks-trusted-self-hosted": "b8dac89af1f63b0528c7b2209e071e4f88919f82fb33562591eaf6b50c0186ea"
        }
    },
    "trivy.yml": {
        "control_sha256": "7458d438680dcf24af04e6b0843c6e5efcde6dbdc404ca993df40a1c162704da",
        "jobs": {
            "admission-gate": "52b78b693b432e996505e18a415bb66bc937f0cd04ae69abf336c868d38591d2",
            "trivy-trusted-self-hosted": "67c881212b4932617134a79cf3e8153de4bf5024b30bbbfa2dd129863b05c9bd"
        }
    }
}

# Owner Decisions 61b65d61 and 494326b5 (FABLE-cicd-framework-v1 §2.3, G7): the
# hosted scaffold. Until the independent CI blocks merges on its own, the seven
# required checks run once more on GitHub-hosted runners under hosted- names
# (hosted-required.yml), which the scaffold ruleset requires. Pinned exactly like
# the tables above (workflow controls and every job's bytes); every check name a
# scaffold job can carry starts with "hosted-", so none can stand in for a
# check of the independent CI. The hosted copy of the front-merge-main workflow
# (clued-front-main-merge-hosted.yml) belongs to the same scaffold under the same
# rule: its two jobs carry hosted- names. hosted-ci-suites-windows runs as four Windows
# shards, a summary job of that name and a non-required duration job (task 3435f8bf
# block 4); a matrix job's name is a format() whose literal starts with "hosted-",
# the one quoted branch job_check_names reads. Temporary: at the switch back (stage S8) the
# workflows and these entries are deleted in one change; a stale entry fails.
HOSTED_SCAFFOLD_SOURCE = "61b65d61"
HOSTED_SCAFFOLD_PREFIX = "hosted-"
HOSTED_SCAFFOLD_JOBS = {
    "hosted-required.yml": {
        "control_sha256": "9a057883ee2ed3562058c81812778c539a19dda2afc1571c5cf1d50ae1c6ac76",
        "jobs": {
            "clued-cloud-tests": "6cbe5548054ab7718475ae8cfb85ce095ea7761526f2b184bdf01b7696fa0bcb",
            "ci-suites": "f76d702d186df8db2a7877dcb4bac03c6202775740f16667027193c33bfcab95",
            "migration-verify": "99c0769279ea8f6c0b5a485b2d80e2ef163642e4c5f191cbb3dd493487714da1",
            "ci-suites-windows-shard": "b4fcbce1fd84783fbfc90448fe28b1123230d866efb04b46b0ea500360877953",
            "ci-suites-windows": "5071b13bdf66b49332eb45beefc7b4941f9666a6f4d5659606d232ce61e901a4",
            "ci-suites-windows-duration": "9cfd47298e34cea4eca39a7ad78e5a4b4dfd08c356ee42ccd511066b73a99653",
            "gitleaks": "4d532d733482aa3d94c2f83c33954b9af8e420c387cf1cd8b473e8f92aae45f6",
            "trivy": "7a5b2fee28fb2304c03a4d70c35832b64cbac60d70dc0a8c6f26eafc04bbb18a",
            "contract-placement": "a07add60bcd9ec6caee62f0e86213c48ce3d16700894dc71e38b75a9493334df"
        }
    },
    "clued-front-main-merge-hosted.yml": {
        "control_sha256": "5f732deb1d366951e326ad41fb74df57a56db845b79be95956c25352346cd8a7",
        "jobs": {
            "scaffold-phase": "973b475909436bd551f30f1cfc8d64d06178c340d89f4ceeb98725169edac16c",
            "merge-main": "fcaa51b208689f3427c000b2f31e94c89a51c49e9ecf7a1500eb6db9a983c04d"
        }
    }
}

# Exact local Source-candidate successors only. The original 42 debt rows,
# six Owner jobs and their historical hashes above remain byte-for-byte intact.
# Matching both the entire workflow and exact predecessor map never activates
# execution; unknown changes still use and fail the original pinned map.
EXACT_SOURCE_CANDIDATE_SUCCESSORS = {'gitleaks.yml': {'kind': 'owner',
                  'source_commit': 'c8c146b4067a32a0ed3a1a6be04dda52a59dd4db',
                  'workflow_sha256': '116e6b201e30251b0f702ff4416dcfd015d2b311cbd2f000cdcd3e81e6d29966',
                  'predecessor': {'control_sha256': 'f5b93595feb30ef1f9bf436fce82a08e07e0559ea706bc6af60f26c01483f301',
                                  'jobs': {'admission-gate': '52b78b693b432e996505e18a415bb66bc937f0cd04ae69abf336c868d38591d2',
                                           'gitleaks-trusted-self-hosted': 'b8dac89af1f63b0528c7b2209e071e4f88919f82fb33562591eaf6b50c0186ea'}},
                  'successor': {'control_sha256': 'f5b93595feb30ef1f9bf436fce82a08e07e0559ea706bc6af60f26c01483f301',
                                'jobs': {'admission-gate': '52b78b693b432e996505e18a415bb66bc937f0cd04ae69abf336c868d38591d2',
                                         'gitleaks-trusted-self-hosted': 'ae8cea670f38536ff6f5ef5b5be17cd990b49702a0e18f00fae36b9d3598285a'}}},
 'clued-merge-slot-ci.yml': {'kind': 'legacy',
                             'source_commit': 'c8c146b4067a32a0ed3a1a6be04dda52a59dd4db',
                             'workflow_sha256': 'f8ae06eb8a2e1cbe6b0ff91514067f7c216f6551fdf8cf3a8c24e0715a53abfa',
                             'predecessor': {'control_sha256': '500da29fb3c1fbe9df2be795e84f92908249a8ee057bef709e17e5aa7c5e341f',
                                             'jobs': {'report': '13d032eddeef15d56c9b98d7e74cc09325e6b40fbbe190820bd9aa86a2f41089'}},
                             'successor': {'control_sha256': '9c7974ece331a8d86524ab75301f86159ffd6d01cbc2684d24417d2a92ac94ed',
                                           'jobs': {'report': '13d032eddeef15d56c9b98d7e74cc09325e6b40fbbe190820bd9aa86a2f41089'}}}}

# The clued-merge-slot-ci.yml successor above is the home-linux-01 retirement
# Source (Owner Decision 2907d858): it differs from the previous successor
# (workflow 670c8e3b..., control efbfbb17...) only by removing the one
# "Clued handover hook qualification / home-linux-01" workflow_run signal. The
# report job hash, hosted route, permissions and every other trigger stay frozen,
# and the original debt row above is untouched. No new hosted debt is added.

# Owner Decision bc6fdad1: GitHub treats every check run that carries a
# required check's name as that required check, whatever its integration, so a
# failing hosted run blocks the merge although the ruleset pins App 5368905. No
# Owner-decision hosted executor may carry one of these names, in any branch of
# a dynamic name expression; a job without a name is checked by its job ID.
REQUIRED_CHECK_NAMES = frozenset({
    "gitleaks", "trivy", "kooyumi-work-admission", "kooyumi-admission-verified",
    "kooyumi-merge-slot", "contract-placement",
})

# These existing heartbeat arrays contain literal self-hosted/trust-internal
# labels, plus one matrix selector. They cannot fall back to a hosted runner.
# No new dynamic selector or entire expression-based route is admitted.
EXISTING_SELF_HOSTED_MATRIX_ROUTES = {
    "clued-ci-runner-heartbeat.yml/windows-route": "[self-hosted, Windows, X64, clued, pool-general, trust-internal, cap-python312, \"${{ matrix.site_label }}\"]",
    "clued-ci-runner-heartbeat.yml/linux-route": "[self-hosted, Linux, X64, clued, pool-general, trust-internal, cap-docker-linux, runtime-wsl2, \"${{ matrix.route_label }}\"]"
}
STATE_CHANGE_RUNNER = (
    "$" + "{{ inputs.reason == 'state_change' && 'ubuntu-latest' || 'ubuntu-slim' }}"
)
HOSTED_LABEL = re.compile(r"^(?:ubuntu|windows|macos)-[A-Za-z0-9._-]+$", re.I)
LABEL = re.compile(r"^[A-Za-z0-9._-]+$")
JOB_KEY = re.compile(r"^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$")
FIELD_KEY = re.compile(r"^    ([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$")
ROOT_KEY = re.compile(r"^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
HIDDEN_CHARACTER = re.compile(r"\r(?!\n)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x85\u2028\u2029]")


def normalized_lf(text: str) -> str:
    """Only CRLF and terminal empty lines are normalized; content stays exact."""
    return text.replace("\r\n", "\n").rstrip("\n") + "\n"


def source_hash(text: str) -> str:
    return hashlib.sha256(normalized_lf(text).encode("utf-8")).hexdigest()


def split_workflow(text: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """Fail-closed canonical subset, matching the repository admission reader.

    No parser dependency is installed in CI. Quoted/flow jobs, duplicate keys,
    aliases/merge keys, hidden line breaks and trailing root sections refuse
    instead of being classified with a permissive text search.
    """
    if HIDDEN_CHARACTER.search(text) or "\t" in text:
        raise ValueError("ambiguous workflow characters")
    lines = normalized_lf(text).split("\n")
    positions = [i for i, line in enumerate(lines) if re.match(r"^(?:['\"]?jobs['\"]?)\s*:", line)]
    if len(positions) != 1 or lines[positions[0]] != "jobs:":
        raise ValueError("jobs must be one bare block")
    start = positions[0]
    top: dict[str, str] = {}
    top_start: int | None = None
    top_name: str | None = None
    for i, line in enumerate(lines[:start]):
        if not line.strip() or line.lstrip().startswith("#") or line.startswith(" "):
            continue
        match = ROOT_KEY.fullmatch(line)
        if not match or match[1] in top:
            raise ValueError("ambiguous or duplicate workflow control")
        if top_name is not None:
            top[top_name] = "\n".join(lines[top_start:i])
        top_name, top_start = match[1], i
        top[top_name] = ""
    if top_name is not None:
        top[top_name] = "\n".join(lines[top_start:start])
    if "on" not in top:
        raise ValueError("workflow trigger missing")
    jobs: dict[str, str] = {}
    current: str | None = None
    block_start = start + 1
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if re.match(r"^\s*<<\s*:", line):
            raise ValueError("YAML merge routes are not supported")
        match = JOB_KEY.fullmatch(line)
        if match:
            if match[1] in jobs:
                raise ValueError("duplicate job")
            if current is not None:
                jobs[current] = normalized_lf("\n".join(lines[block_start:i]))
            current, block_start = match[1], i
            jobs[current] = ""
        elif current is None or not line.startswith("    "):
            raise ValueError("ambiguous job or trailing workflow control")
    if current is None:
        raise ValueError("workflow has no jobs")
    jobs[current] = normalized_lf("\n".join(lines[block_start:]))
    return normalized_lf("\n".join(lines[:start])), jobs, top


def job_fields(block: str) -> dict[str, str]:
    lines = block.splitlines()
    fields: dict[str, str] = {}
    current: str | None = None
    for line in lines[1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("    ") and not line.startswith("     "):
            match = FIELD_KEY.fullmatch(line)
            if not match or match[1] in fields:
                raise ValueError("ambiguous or duplicate job field")
            current = match[1]
            fields[current] = match[2] or ""
        elif current is not None:
            fields[current] += "\n" + line
        else:
            raise ValueError("job field missing")
    return fields


def strip_comment(text: str) -> str:
    quote: str | None = None
    for i, char in enumerate(text):
        if quote:
            if char == quote and (i == 0 or text[i - 1] != "\\"):
                quote = None
        elif char in "'\"":
            quote = char
        elif char == "#" and (i == 0 or text[i - 1].isspace()):
            return text[:i].strip()
    return text.strip()


def scalar(text: str) -> str:
    value = strip_comment(text)
    if len(value) >= 2 and value[0] in "'\"" and value[-1] == value[0]:
        return value[1:-1]
    return value


def classify_route(filename: str, job_id: str, fields: dict[str, str]) -> tuple[str, list[str]]:
    value = fields.get("runs-on", "")
    if "uses" in fields or not value.strip():
        return "unknown", []
    route = "\n".join(strip_comment(line) for line in value.splitlines()).strip()
    if route == STATE_CHANGE_RUNNER:
        return "legacy-hosted-dynamic", []
    if "\n" not in route and HOSTED_LABEL.fullmatch(scalar(route)):
        return "hosted", []
    if route.startswith("[") and route.endswith("]") and "\n" not in route:
        labels = [scalar(part) for part in route[1:-1].split(",")]
    elif "\n" in value and not strip_comment(value.splitlines()[0]):
        labels = []
        for line in value.splitlines()[1:]:
            cleaned = strip_comment(line)
            if cleaned:
                match = re.fullmatch(r"-\s+(.+)", cleaned)
                if not match:
                    return "unknown", []
                labels.append(scalar(match[1]))
    elif scalar(route) == "self-hosted":
        labels = ["self-hosted"]
    else:
        return "unknown", []
    if "self-hosted" not in labels or any(HOSTED_LABEL.fullmatch(label) for label in labels):
        return "unknown", labels
    if not all(LABEL.fullmatch(label) for label in labels):
        if EXISTING_SELF_HOSTED_MATRIX_ROUTES.get(filename + "/" + job_id) != route:
            return "unknown", labels
    return "self-hosted", labels


def job_check_names(job_id: str, fields: dict[str, str]) -> set[str]:
    """Every name a job's check run can carry: each quoted branch of a dynamic name."""
    if "name" not in fields:
        return {job_id}
    raw = " ".join(strip_comment(line) for line in fields["name"].splitlines()).strip()
    if "${{" in raw:
        return set(re.findall(r"'([^']*)'", raw))
    return {scalar(raw)}


def baseline_findings(baseline: object) -> list[str]:
    if not isinstance(baseline, dict):
        return ["legacy debt baseline is not a mapping"]
    findings = []
    for file, entry in baseline.items():
        if not isinstance(file, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+\.ya?ml", file):
            findings.append("invalid legacy debt workflow identity")
        if not isinstance(entry, dict) or set(entry) != {"control_sha256", "jobs"}:
            findings.append("invalid legacy debt entry schema")
            continue
        if not isinstance(entry["control_sha256"], str) or not SHA256.fullmatch(entry["control_sha256"]):
            findings.append("invalid legacy control hash")
        jobs = entry["jobs"]
        if not isinstance(jobs, dict) or not jobs:
            findings.append("empty legacy workflow entry must be deleted")
            continue
        for job, digest in jobs.items():
            if not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", job):
                findings.append("invalid legacy job identity")
            if not isinstance(digest, str) or not SHA256.fullmatch(digest):
                findings.append("invalid legacy job hash")
    return findings


def owner_decision_findings(exceptions: object, baseline: dict) -> list[str]:
    """Same exact schema as the debt baseline; never both debt and exception."""
    if not isinstance(exceptions, dict):
        return ["Owner-decision hosted exception is not a mapping"]
    findings = []
    for file, entry in exceptions.items():
        if not isinstance(file, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+\.ya?ml", file):
            findings.append("invalid Owner-decision hosted workflow identity")
        if not isinstance(entry, dict) or set(entry) != {"control_sha256", "jobs"}:
            findings.append("invalid Owner-decision hosted entry schema")
            continue
        if not isinstance(entry["control_sha256"], str) or not SHA256.fullmatch(entry["control_sha256"]):
            findings.append("invalid Owner-decision hosted control hash")
        jobs = entry["jobs"]
        if not isinstance(jobs, dict) or not jobs:
            findings.append("empty Owner-decision hosted workflow entry must be deleted")
            continue
        for job, digest in jobs.items():
            if not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", job):
                findings.append("invalid Owner-decision hosted job identity")
            if not isinstance(digest, str) or not SHA256.fullmatch(digest):
                findings.append("invalid Owner-decision hosted job hash")
            legacy = baseline.get(file) if isinstance(file, str) else None
            if isinstance(legacy, dict) and isinstance(legacy.get("jobs"), dict) and job in legacy["jobs"]:
                findings.append("a job is either legacy debt or Owner-decision hosted, never both")
    return findings


def evaluate_workflows(texts: dict[str, str], baseline: object = None,
                       owner_hosted: object = None, scaffold: object = None) -> dict[str, object]:
    scaffold = HOSTED_SCAFFOLD_JOBS if scaffold is None else scaffold
    baseline = LEGACY_HOSTED_DEBT if baseline is None else baseline
    owner_hosted = OWNER_DECISION_HOSTED_JOBS if owner_hosted is None else owner_hosted
    violations: list[dict[str, str]] = []
    records = []
    def reject(file: str, reason: str, job: str | None = None) -> None:
        violations.append({"workflow": file, **({"job": job} if job else {}), "reason": reason})
    errors = baseline_findings(baseline)
    for error in errors:
        reject("<embedded-baseline>", error)
    if errors:
        baseline = {}
    owner_errors = owner_decision_findings(owner_hosted, baseline)
    for error in owner_errors:
        reject("<embedded-owner-decision>", error)
    if owner_errors:
        owner_hosted = {}
    scaffold_errors = [error.replace("Owner-decision hosted", "hosted scaffold")
                       for error in owner_decision_findings(scaffold, baseline)]
    for file, entry in (scaffold.items() if isinstance(scaffold, dict) else []):
        if file in owner_hosted:
            scaffold_errors.append("a workflow is either Owner-decision hosted or hosted scaffold, never both")
    for error in scaffold_errors:
        reject("<embedded-hosted-scaffold>", error)
    if scaffold_errors:
        scaffold = {}
    observed = set()
    observed_owner = set()
    observed_scaffold = set()
    for filename, text in sorted(texts.items()):
        try:
            control, jobs, top = split_workflow(text)
            fields = {job: job_fields(block) for job, block in jobs.items()}
        except ValueError as error:
            reject(filename, str(error))
            continue
        entry = baseline.get(filename)
        owner_entry = owner_hosted.get(filename)
        scaffold_entry = scaffold.get(filename)
        successor = EXACT_SOURCE_CANDIDATE_SUCCESSORS.get(filename)
        if successor and source_hash(text) == successor["workflow_sha256"]:
            if successor["kind"] == "legacy" and entry == successor["predecessor"]:
                entry = successor["successor"]
            elif successor["kind"] == "owner" and owner_entry == successor["predecessor"]:
                owner_entry = successor["successor"]
        pr_triggered = bool(re.search(r"\bpull_request(?:_target)?\b", top["on"]))
        concurrency = top.get("concurrency", "")
        has_cancel = bool(re.search(r"(?m)^\s+cancel-in-progress\s*:", concurrency))
        routes = []
        for job_id, block in jobs.items():
            kind, labels = classify_route(filename, job_id, fields[job_id])
            legacy_hash = entry["jobs"].get(job_id) if entry else None
            if legacy_hash:
                observed.add((filename, job_id))
                if kind == "self-hosted":
                    reject(filename, "migrated hosted debt entry must be deleted; it cannot authorize restoration", job_id)
                else:
                    if source_hash(control) != entry["control_sha256"]:
                        reject(filename, "legacy hosted workflow controls changed", job_id)
                    if source_hash(block) != legacy_hash:
                        reject(filename, "legacy hosted job changed", job_id)
            owner_hash = owner_entry["jobs"].get(job_id) if owner_entry else None
            if owner_hash:
                observed_owner.add((filename, job_id))
                if kind != "hosted":
                    reject(filename, "Owner Decision " + OWNER_DECISION_HOSTED_SOURCE +
                           " hosted exception must be deleted once its job leaves the literal hosted route", job_id)
                else:
                    if source_hash(control) != owner_entry["control_sha256"]:
                        reject(filename, "Owner-decision hosted workflow controls changed", job_id)
                    if source_hash(block) != owner_hash:
                        reject(filename, "Owner-decision hosted job changed", job_id)
                    if job_check_names(job_id, fields[job_id]) & REQUIRED_CHECK_NAMES:
                        reject(filename, "Owner-decision hosted executor carries a required check name "
                               "(Owner Decision bc6fdad1)", job_id)
            scaffold_hash = scaffold_entry["jobs"].get(job_id) if scaffold_entry else None
            if scaffold_hash:
                observed_scaffold.add((filename, job_id))
                if kind != "hosted":
                    reject(filename, "Owner Decision " + HOSTED_SCAFFOLD_SOURCE +
                           " hosted scaffold entry must be deleted once its job leaves the literal hosted route", job_id)
                else:
                    if source_hash(control) != scaffold_entry["control_sha256"]:
                        reject(filename, "hosted scaffold workflow controls changed", job_id)
                    if source_hash(block) != scaffold_hash:
                        reject(filename, "hosted scaffold job changed", job_id)
                    names = job_check_names(job_id, fields[job_id])
                    if not names or any(not name.startswith(HOSTED_SCAFFOLD_PREFIX) for name in names):
                        reject(filename, "hosted scaffold job must carry a " + HOSTED_SCAFFOLD_PREFIX +
                               " check name only (Owner Decision " + HOSTED_SCAFFOLD_SOURCE + ")", job_id)
            if kind == "unknown":
                reject(filename, "unknown, dynamic, reusable or mixed runner route is prohibited", job_id)
            elif kind != "self-hosted":
                if not legacy_hash and not owner_hash and not scaffold_hash:
                    reject(filename, "new GitHub-hosted execution is prohibited; use literal self-hosted routing", job_id)
            else:
                if "trust-internal" not in labels:
                    reject(filename, "self-hosted job is missing literal trust-internal capability boundary", job_id)
                if pr_triggered and filename not in CONCURRENCY_EXEMPTIONS:
                    if not concurrency:
                        reject(filename, "PR-triggered self-hosted workflow is missing top-level concurrency", job_id)
                    elif not has_cancel:
                        reject(filename, "PR-triggered self-hosted workflow is missing cancel-in-progress", job_id)
            routes.append({"job": job_id, "kind": kind, "runs_on": fields[job_id].get("runs-on"),
                           "job_sha256": source_hash(block), "legacy_migration_debt": bool(legacy_hash),
                           "owner_decision_hosted": bool(owner_hash), "hosted_scaffold": bool(scaffold_hash)})
        records.append({
            "workflow": filename, "jobs": routes, "control_sha256": source_hash(control),
            "runs_on": [row["runs_on"] for row in routes],
            "hosted": any(row["kind"] in {"hosted", "legacy-hosted-dynamic"} for row in routes),
            "self_hosted": any(row["kind"] == "self-hosted" for row in routes),
            "historical_hosted_only_note": HOSTED_ONLY_ALLOWLIST.get(filename),
            "hosted_only_allowlisted": False,
            "pr_triggered": pr_triggered, "has_concurrency": bool(concurrency),
            "has_cancel_in_progress": has_cancel,
            "concurrency_exempt": filename in CONCURRENCY_EXEMPTIONS,
        })
    for filename, entry in baseline.items():
        for job_id in entry["jobs"]:
            if (filename, job_id) not in observed:
                reject(filename, "removed hosted debt entry must be deleted; stale permits are prohibited", job_id)
    for filename, entry in owner_hosted.items():
        for job_id in entry["jobs"]:
            if (filename, job_id) not in observed_owner:
                reject(filename, "removed Owner-decision hosted job must be deleted; stale permits are prohibited", job_id)
    for filename, entry in scaffold.items():
        for job_id in entry["jobs"]:
            if (filename, job_id) not in observed_scaffold:
                reject(filename, "removed hosted scaffold job must be deleted; stale permits are prohibited", job_id)
    return {"schema": "clued.ci-runner-budget-policy/v3", "status": "FAIL" if violations else "PASS",
            "policy": "self-hosted-only-new-execution; exact legacy debt must shrink on migration; "
                      "exact Owner Decision " + OWNER_DECISION_HOSTED_SOURCE + " hosted executor jobs",
            "legacy_debt_source": LEGACY_HOSTED_DEBT_SOURCE,
            "legacy_debt_jobs": sum(len(entry["jobs"]) for entry in baseline.values()),
            "owner_decision_hosted_source": OWNER_DECISION_HOSTED_SOURCE,
            "owner_decision_hosted_jobs": sum(len(entry["jobs"]) for entry in owner_hosted.values()),
            "hosted_scaffold_source": HOSTED_SCAFFOLD_SOURCE,
            "hosted_scaffold_jobs": sum(len(entry["jobs"]) for entry in scaffold.values()),
            "historical_hosted_only_notes": HOSTED_ONLY_ALLOWLIST,
            "concurrency_exemptions": CONCURRENCY_EXEMPTIONS,
            "workflows": records, "violations": violations}


def main() -> int:
    texts = {path.name: path.read_text(encoding="utf-8")
             for path in sorted([*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")])}
    if not texts:
        print(json.dumps({"schema": "clued.ci-runner-budget-policy/v3", "status": "FAIL",
                          "violations": [{"workflow": "<directory>", "reason": "workflow directory is empty"}]}))
        return 1
    report = evaluate_workflows(texts)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
