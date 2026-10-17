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
    "clued-work-claim-handover-revoke.yml": (
        "Task 6176fdcc private-handover consumer: a bounded five-minute sweep on the default branch revokes required App checks and confirms stopped old PR/dispatch jobs before ACK. The admission Binding and App remain in the isolated clued-admission environment, never on a self-hosted runner; no application dependency install or pull-request trigger."
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
    "phase2-naming-surface-inventory.yml": (
        "Frozen historical exact-byte inventory workflow; modifying its execution contract would invalidate bound evidence."
    ),
    "phase2-v027-validation.yml": (
        "Frozen historical exact-source validation lane with self-referential accepted-source bindings."
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
        "control_sha256": "093a0a6f554c2d4aa18dbb97e3626fdf0551bc540972255172ad89d6ddef1317",
        "jobs": {
            "links-untrusted-hosted": "9243db8b4e05e66f46d25626efc278147b8fcaa78b3e268d4ea72f2f05dbd70d"
        }
    },
    "clued-capture-guard.yml": {
        "control_sha256": "af42acacfdf4ee20d1a16fa40432278888358df8eede47755464df0fb61cd55c",
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
        "control_sha256": "82824a3fbea39f142556ab30007e927f4e67e16bc3fb337dfd92b264cd232910",
        "jobs": {
            "untrusted-hosted": "f9c084c82de1ab02bcfff451680b9f562385dba67ea4b53bd1b1b3645029a978"
        }
    },
    "clued-cloud-production-release.yml": {
        "control_sha256": "ba9aebecbf6b9a87fdfb2563ba8f223bfbfe4e44211ca32dac64145c48a53f68",
        "jobs": {
            "release": "354f88e193f04c37b9adcd9a8390041558d6d71da34ebbf3203bba59e00414c0"
        }
    },
    "clued-cloud-quality-gate.yml": {
        "control_sha256": "308387e658cd8ac4d5edbcd286f9285e562c81ce7a344922424c50e1484c6f46",
        "jobs": {
            "untrusted-hosted": "50123d63d447c0b0ba475b3263368d928d6743f7977b01c608745b2c5ea915ff"
        }
    },
    "clued-components.yml": {
        "control_sha256": "5a4c866aa0d8333cf2a6ce5973f01ef986544831d77fbe49513ebbc6324190ff",
        "jobs": {
            "untrusted-hosted": "6babc102fba76d91397d52f013291fe4646b273b3c05399393498bfaf3a12bdb"
        }
    },
    "clued-connection-authorization.yml": {
        "control_sha256": "3b612ffbd70f686787c9c4b73717a49dcf1c42a38e59ba6c7a63543a34530c1e",
        "jobs": {
            "isolated-candidate-untrusted-hosted": "55c18e5085b2f39b17e6f1bd0842720d61e00f89ac1ac151689e616b46033edd"
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
    "clued-handover-disposable-idle.yml": {
        "control_sha256": "545191670af2267b6812173cbcb8fdb934860e46dedb192d1c05464b0b25f5a6",
        "jobs": {
            "disposable-idle": "f1e887913fead7b1a04ad67c419bd6118ce4a0454778b6c454c05373c6da0b03"
        }
    },
    "clued-handover-external-qualification.yml": {
        "control_sha256": "6d47cf51322c3948a02ece0168db778893ec27e763a5bd2b27dfa06fb964b5da",
        "jobs": {
            "qualify": "206ffbd3e581d256ac6ec8a51615666836459725df4b96969a3523ad855a37b7"
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
        "control_sha256": "ebb3e31056796a46bdfddabb880da1173bdb5128b9e88dded3ee4792b7491745",
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
    "clued-work-claim-handover-revoke.yml": {
        "control_sha256": "50ea6e5ffa83b03ee4ebb79ef7bedc0fa3386f4abc8957808fa64089905a7427",
        "jobs": {
            "revoke": "05c9112397ce11199544fa0893d674ff79b89db5683030a8fa8c293ceab97437"
        }
    },
    "contract-placement.yml": {
        "control_sha256": "7f6b17e3f081e3efe50994f9919f82493625335bfb68b965fb4e9da6165d43af",
        "jobs": {
            "contract-placement": "ece793557cdd471a62f4937faf0144ed1a4fac8994267264ee24e2afd513c445"
        }
    },
    "design-refs.yml": {
        "control_sha256": "6327e8203db425c4bf5c2ae87d1c4e58a235307ce616fdc5f4a7db93c0b2b6c8",
        "jobs": {
            "design-refs-untrusted-hosted": "5639d9ad5c5f6181caa118e9c55c6f370b55f442447f9e0685976870eb8ac8d2"
        }
    },
    "gitleaks.yml": {
        "control_sha256": "3ab12e6a86c95658f6c17347a2f81a45184e6b0ff45ef4d1487494b5514b9794",
        "jobs": {
            "gitleaks-untrusted-hosted": "4380f116c52b6a654d5f4edae17ce62e4523bd89b1564302d6882dbaeab712cb"
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
        "control_sha256": "0eefb33d740f4f61e4c7e31b37d902eccaf2e935aeaec0181bef5778b8c7e6fc",
        "jobs": {
            "validate-untrusted-hosted": "772a3eb010a62b889d18be7da42b7977415ab9f12d7799199e1700384fc711bc"
        }
    },
    "model-program-m1-entry.yml": {
        "control_sha256": "8b6c80241e609eb13820d40be7ac87cfa1cb92aa375931a13cdf9c1c2acb7022",
        "jobs": {
            "validate-untrusted-hosted": "1e35ba7c3040ca729c2e4612cc9eab04c3bc6027af92dd322a848b6077b48394"
        }
    },
    "model-program-m1-harness.yml": {
        "control_sha256": "4f13bdff24ca46b990d16d3dfb999c43304204ee02e3c69eda7bbc76cfe65985",
        "jobs": {
            "validate-untrusted-hosted": "49e277ffb578d1d662a5e240dbb56e22189cee7e4f9c4d9de763dde672d03dc7"
        }
    },
    "model-program-m1-package.yml": {
        "control_sha256": "5f2f64757a1152a2299659f90f107b0383e6265743b39f89da53617b42b2de93",
        "jobs": {
            "validate-untrusted-hosted": "306e9ad3c4d0f9a5c337c2463af26cdd211ba92f36dc128805bc2317236c7431"
        }
    },
    "model-program-m2-scoped-consumer.yml": {
        "control_sha256": "cd093d7a7aafc5eeec576fdd2f3b9fa4ff9d50cfbf40c141fc6c79d674c376e4",
        "jobs": {
            "untrusted-linux": "55c967ce7b401611df6e2673dbf78a4ff883d0d377a52c9e1cb9bc6edc1603fd"
        }
    },
    "multitrack-governance-projection.yml": {
        "control_sha256": "94c0dfc24e1313bd12d9a009d24387bb9fd7301e28e30df263644a8bbad400da",
        "jobs": {
            "validate-untrusted-hosted": "be5115297f448fc75299797d3d94e1e82786980a37f6cbc218283baf8736a868"
        }
    },
    "node-profile-policy.yml": {
        "control_sha256": "335ae03fbfc515cfa1502e48342c80804719d9f226a20a2949e8219796baeec1",
        "jobs": {
            "untrusted-hosted": "e6b8787973d2f48fcb4435b55bb136bfd8a627602acc575dcce25d680bd43452"
        }
    },
    "phase2-naming-surface-inventory.yml": {
        "control_sha256": "9d0afb3c004db56864ae1e5f8faaefa9f8f2346da84f9d7eb81ac8e18d8e2dcd",
        "jobs": {
            "inventory": "ae8245234f81f220ccad5eb22392b3ff4b683737457f97fda1e2b7e2e15c6feb"
        }
    },
    "phase2-v027-validation.yml": {
        "control_sha256": "e3f6e7958c64ff61f23c9d8eba95f23c8c393233b022add0418d3571787f2127",
        "jobs": {
            "validate-v027": "d833b3d8aec21655f5f7c477594d0ec47318ca7a1308901ba52688e0e8877880",
            "permission-check": "62b123972ca9f91b2581de7f72b52338d781fce4511a467b03b12b68973879e3"
        }
    },
    "public-mcp-behavior.yml": {
        "control_sha256": "3cfab33876aec48f8421f98267a400b02f6f7cf7766680aa9627d82dfa2ad344",
        "jobs": {
            "untrusted-hosted": "c8abc2a96948c6f4552e7578aa0bb24565da47aeb3c562db478b725048c20d4e"
        }
    },
    "public-mcp-gate-receipt.yml": {
        "control_sha256": "f7d7f7e20c5d3ba14d60b12ac1820b810d8982e8be518cb5c8598b3d5b248de0",
        "jobs": {
            "untrusted-hosted": "e110e5b26d91532d19be905c89f855f00759b9f21ab21625c2480ca9e58cbdfe"
        }
    },
    "public-mcp-protocol.yml": {
        "control_sha256": "64e5fdc0e4689afba1dd8fcea722c87464f9b9a990edfc05ccd82bb0c2874a27",
        "jobs": {
            "untrusted-hosted": "8f3caece0a4eaa6eda10802811fc19c074acb2210aeae7000190dd41c0921104"
        }
    },
    "runner-budget-policy.yml": {
        "control_sha256": "44132161236e58006357936aeffc66876cf3e453188ad0f3cdf5abc0f5a8f346",
        "jobs": {
            "untrusted-hosted": "6c05c4e934d9565c13a14945e52f5a25490760088e740e17fd252cc2f268a564"
        }
    },
    "trivy.yml": {
        "control_sha256": "518a419739455958d4c1aea912180ba241be7cff4e988c7263efc6f89f9db6c2",
        "jobs": {
            "trivy-untrusted-hosted": "cf29c5704f534cc39384472b5b2a0a7efe3ffe2ffdc2abe81e7b04eef3cf2e80"
        }
    }
}

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


def evaluate_workflows(texts: dict[str, str], baseline: object = None) -> dict[str, object]:
    baseline = LEGACY_HOSTED_DEBT if baseline is None else baseline
    violations: list[dict[str, str]] = []
    records = []
    def reject(file: str, reason: str, job: str | None = None) -> None:
        violations.append({"workflow": file, **({"job": job} if job else {}), "reason": reason})
    errors = baseline_findings(baseline)
    for error in errors:
        reject("<embedded-baseline>", error)
    if errors:
        baseline = {}
    observed = set()
    for filename, text in sorted(texts.items()):
        try:
            control, jobs, top = split_workflow(text)
            fields = {job: job_fields(block) for job, block in jobs.items()}
        except ValueError as error:
            reject(filename, str(error))
            continue
        entry = baseline.get(filename)
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
            if kind == "unknown":
                reject(filename, "unknown, dynamic, reusable or mixed runner route is prohibited", job_id)
            elif kind != "self-hosted":
                if not legacy_hash:
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
                           "job_sha256": source_hash(block), "legacy_migration_debt": bool(legacy_hash)})
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
    return {"schema": "clued.ci-runner-budget-policy/v3", "status": "FAIL" if violations else "PASS",
            "policy": "self-hosted-only-new-execution; exact legacy debt must shrink on migration",
            "legacy_debt_source": LEGACY_HOSTED_DEBT_SOURCE,
            "legacy_debt_jobs": sum(len(entry["jobs"]) for entry in baseline.values()),
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
