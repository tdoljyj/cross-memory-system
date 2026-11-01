"""Validate the public STOP evidence for an exact half-uninstall continuation.

This pure parser does not authorize a launch or touch installed state. A
continuation must additionally recheck all live host guards before renaming.
"""
import hashlib
import json
import re


def require(condition, code):
    if not condition:
        raise ValueError(code)


def validate_terminal(raw, expected_sha, source_sha, package_head):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 16 * 1024 * 1024, 'PRIOR_TERMINAL_SIZE')
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') is not None
            and hashlib.sha256(raw).hexdigest() == expected_sha, 'PRIOR_TERMINAL_CHANGED')
    # sourceSha names the Git COMMIT, not the 64-character manifest digest.
    require(re.fullmatch(r'[0-9a-f]{40}', source_sha or '') is not None
            and re.fullmatch(r'[0-9a-f]{40}', package_head or '') is not None, 'RESUME_SUBJECT_INVALID')
    document = json.loads(raw.decode('utf-8-sig'))
    require(isinstance(document, dict)
            and document.get('contract') == 'clued.independent-ci.source-v2-windows-launch-terminal/1'
            and document.get('status') == 'STOPPED' and document.get('code') == 'UNINSTALL_NOT_COMPLETED'
            and document.get('sourceSha') == source_sha and document.get('packageHead') == package_head,
            'PRIOR_TERMINAL_NOT_THE_FAILED_UNINSTALL')
    done = document.get('completed')
    required = ['output', 'package', 'stage', 'uninstall-preflight', 'parent-acl-checked', 'quiesce']
    require(isinstance(done, list) and all(isinstance(x, str) for x in done)
            and len(set(done)) == len(done) and done == required, 'PRIOR_UNINSTALL_STEP_BOUNDARY')
    detail = document.get('detail')
    require(isinstance(detail, dict), 'PRIOR_UNINSTALL_DETAIL')
    dry = detail.get('dryRun')
    require(isinstance(dry, dict) and type(dry.get('exit')) is int and dry['exit'] == 0
            and dry.get('status') == 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'
            and re.fullmatch(r'[0-9a-f]{64}', dry.get('planSha256') or '') is not None,
            'PRIOR_UNINSTALL_PLAN_REFUSED')
    plan = dry.get('plan')
    require(isinstance(plan, dict) and plan.get('contract') == 'clued.independent-ci.resident-uninstall-plan/3'
            and type(plan.get('openBatches')) is int and plan['openBatches'] == 0
            and plan.get('runnerOriginalStopped') is True and plan.get('runnerSddlUnchanged') is True
            and plan.get('executorAlive') is False and plan.get('upgraderService') is True
            and 'upgradeOpState' in plan and plan['upgradeOpState'] is None
            and plan.get('renameTo') == 'resident-uninstalled-<UTC>-<hex>'
            and plan.get('deletesEvidence') is False, 'PRIOR_UNINSTALL_PLAN_REFUSED')
    apply = detail.get('apply')
    require(isinstance(apply, dict) and type(apply.get('exit')) is int and apply['exit'] != 0
            and apply.get('keptAt') in (None, '') and apply.get('status') != 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT',
            'PRIOR_UNINSTALL_ALREADY_COMPLETED_OR_UNKNOWN')
    after = detail.get('after')
    require(isinstance(after, dict) and after.get('residentRootExists') is True
            and after.get('processesUnderRoot') == [], 'PRIOR_UNINSTALL_ROOT_NOT_QUIET')
    return {
        'contract': 'clued.independent-ci.resume-uninstall-evidence/1',
        'sourceSha': source_sha, 'packageHead': package_head,
        'priorTerminalSha256': expected_sha, 'uninstallPlanSha256': dry['planSha256'],
        'completed': done,
    }
