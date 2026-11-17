#!/usr/bin/env python3
"""Claude Code hooks that tell the session whether its BeamingFace components are current.

config/clued-components.json (scripts/clued_components.py) gives every BeamingFace
component a version. This script compares what this machine holds with what
the BeamingFace service reports, at the two moments a session actually starts work;
it never runs on a schedule (AGENTS.md: version checks are request-triggered).

* SessionStart: reads the service's /.well-known/clued-continuity
  (`components.versions`, `lifecycle.contract.version`) and compares it with
  this checkout's manifest and with every installed copy of the BeamingFace Skill it
  can find (~/.claude/skills, synced claude.ai Skills, $CODEX_HOME/skills).
  A copy without a version, older than the latest, or whose files differ from
  its version is reported with the fix.
* PostToolUse on clued_session_resume: compares the resume's
  `contract_version` and `clued_components` with this checkout, so a mismatch
  is put in front of the agent the moment it appears (agent-contract §1.6).

The script only adds context; it never blocks and always exits 0. Set
CLUED_VERSION_CHECK=off to disable it, or =offline to skip the service read.
CLUED_ORIGIN overrides the service origin. Task 6dfd7560.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

__version__ = "1.0.5"

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import clued_components as cc  # noqa: E402

DEFAULT_ORIGIN = "https://kooyumi.pixelgrav.com"
SKILL_ID = "skill.clued"
CONTRACT_ID = "agent-contract"
TIMEOUT_SECONDS = 3


def checkout_root() -> Path:
    """The checkout this script belongs to; its manifest is the local truth."""
    return SCRIPTS.parent


def local_versions(root: Path) -> dict[str, str]:
    return {c["id"]: c["version"] for c in cc.load_manifest(root)["components"]}


def fetch_served(origin: str) -> tuple[dict | None, str | None]:
    request = urllib.request.Request(
        origin.rstrip("/") + "/.well-known/clued-continuity",
        headers={"accept": "application/json", "user-agent": f"clued-version-check/{__version__}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode())
    except Exception as error:  # noqa: BLE001 - an unreachable service only degrades the report
        reason = getattr(error, "reason", None) or error
        return None, f"could not read {origin} ({type(error).__name__}: {str(reason)[:120]})"
    return (data, None) if isinstance(data, dict) else (None, "the service returned no JSON object")


def served_versions(bootstrap: dict) -> dict[str, str]:
    versions: dict[str, str] = {}
    components = bootstrap.get("components") or bootstrap.get("clued_components")
    if isinstance(components, dict) and isinstance(components.get("versions"), dict):
        versions.update({k: str(v) for k, v in components["versions"].items()})
    contract = ((bootstrap.get("lifecycle") or {}).get("contract") or {}).get("version")
    if contract is not None and CONTRACT_ID not in versions:
        versions[CONTRACT_ID] = str(contract)
    if bootstrap.get("contract_version") is not None and CONTRACT_ID not in versions:
        versions[CONTRACT_ID] = str(bootstrap["contract_version"])
    return versions


def older(left: str | None, right: str | None) -> bool:
    try:
        return left is not None and right is not None and cc.compare_versions(left, right) < 0
    except ValueError:
        return False


def latest(*versions: str | None) -> str | None:
    best = None
    for version in versions:
        if version is not None and (best is None or older(best, version)):
            best = version
    return best


def skill_copies() -> list[Path]:
    home = Path.home()
    candidates = [home / ".claude" / "skills" / "clued"]
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        candidates.append(Path(os.environ["CLAUDE_CONFIG_DIR"]) / "skills" / "clued")
    candidates.append(Path(os.environ.get("CODEX_HOME") or home / ".codex") / "skills" / "clued")
    candidates += sorted((home / ".claude" / "skills" / "synced").glob("*/clued"))
    seen, copies = set(), []
    for path in candidates:
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if resolved not in seen and (path / "SKILL.md").is_file():
            seen.add(resolved)
            copies.append(path)
    return copies


def describe_copy(path: Path, skill: dict, root: Path, newest: str) -> str | None:
    """A problem line for one installed Skill copy, or None when it is current."""
    marker = skill["version_marker"]
    try:
        version = cc.read_marker((path / "SKILL.md").read_text(encoding="utf-8"), marker["pattern"])
    except OSError:
        version = None
    if (path / "references" / "agent-contract.md").is_file():
        state = "carries a bundled agent contract (an older Skill package)"
    elif version is None:
        state = "has no version (it predates component versioning)"
    elif older(version, newest):
        state = f"is version {version}, the latest is {newest}"
    elif (version == skill["version"]
          and cc.content_digest(path, skill["files"]) != cc.content_digest(root / skill["root"], skill["files"])):
        source = root / skill["root"]
        missing = [p.as_posix() for p in cc.component_files(source, skill["files"]) if not (path / p).exists()]
        state = (f"is version {version} but its files differ"
                 + (f" (missing: {', '.join(missing[:5])})" if missing else ""))
    else:
        return None
    return f"- BeamingFace Skill at {path} {state}."


def session_report(payload: dict) -> str:
    root = checkout_root()
    manifest = cc.load_manifest(root)
    local = local_versions(root)
    skill = cc.by_id(manifest)[SKILL_ID]
    lines: list[str] = []
    served: dict[str, str] = {}
    note = None
    if os.environ.get("CLUED_VERSION_CHECK", "").lower() == "offline":
        note = "service read skipped (CLUED_VERSION_CHECK=offline)"
    else:
        origin = os.environ.get("CLUED_ORIGIN") or DEFAULT_ORIGIN
        bootstrap, note = fetch_served(origin)
        if bootstrap is not None:
            served = served_versions(bootstrap)
            if not served:
                note = "the service reports no component versions"

    behind = [f"{cid} {local[cid]} < {served[cid]}" for cid in sorted(served) if older(local.get(cid), served[cid])]
    if behind:
        lines.append("- This checkout is older than the BeamingFace service: " + ", ".join(behind)
                     + ". Fetch origin/main and merge it before relying on these hooks, scripts or the Skill.")
    if older(served.get(CONTRACT_ID), local.get(CONTRACT_ID)):
        lines.append(f"- This checkout's agent contract ({local[CONTRACT_ID]}) is newer than the one the service "
                     f"serves ({served[CONTRACT_ID]}): it is not released yet. The service behaves per the served "
                     "contract (/clued-agent.md).")

    newest = latest(skill["version"], served.get(SKILL_ID))
    stale_copies = [line for line in (describe_copy(p, skill, root, newest) for p in skill_copies()) if line]
    if stale_copies:
        lines += stale_copies
        lines.append(f"  Use skills/clued/ from this checkout (version {skill['version']}) instead of a stale copy. "
                     "Reinstall it: Codex `python3 scripts/update_clued_skills.py`; claude.ai: upload the whole "
                     "skills/clued folder in the Skill settings; Claude Code: copy it to ~/.claude/skills/clued.")

    summary = ", ".join(f"{cid} {local[cid]}" for cid in (SKILL_ID, CONTRACT_ID) if cid in local)
    source = f"service: {note}" if note else "compared with the service"
    if not lines:
        return f"BeamingFace components current ({summary}; {source})."
    return "\n".join([f"BeamingFace component versions ({summary}; {source}):"] + lines)


def response_body(response) -> dict | None:
    """The tool result object, whatever shape the Host passes it in."""
    if isinstance(response, dict):
        if isinstance(response.get("structuredContent"), dict):
            return response["structuredContent"]
        if "status" in response or "contract_version" in response:
            return response
        response = response.get("content")
    if isinstance(response, list):
        response = "".join(b.get("text", "") for b in response if isinstance(b, dict))
    if isinstance(response, str):
        try:
            data = json.loads(response)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None
    return None


def resume_report(payload: dict) -> str | None:
    if not str(payload.get("tool_name", "")).endswith("clued_session_resume"):
        return None
    body = response_body(payload.get("tool_response"))
    if not body:
        return None
    served = served_versions(body)
    local = local_versions(checkout_root())
    lines = []
    contract_local, contract_served = local.get(CONTRACT_ID), served.get(CONTRACT_ID)
    if contract_served and contract_local and contract_served != contract_local:
        lines.append("- Read the current served contract through clued_agent_bootstrap (all parts) "
                     "or /clued-agent.md and follow it before work (agent-contract §1.6). "
                     "A contract change needs no Skill reinstall; if neither path delivers the full text, "
                     "tell the Owner and stop.")
        if older(contract_served, contract_local):
            lines.append(f"- Agent contract: this checkout ({contract_local}) is newer than the served one "
                         f"({contract_served}), which is not released yet; the service behaves per {contract_served}.")
    behind = [f"{cid} {local[cid]} < {served[cid]}" for cid in sorted(served)
              if cid != CONTRACT_ID and older(local.get(cid), served[cid])]
    if behind:
        lines.append("- This checkout is older than the service: " + ", ".join(behind)
                     + ". Fetch origin/main and merge it before relying on it.")
    return "\n".join(["BeamingFace version check on resume:"] + lines) if lines else None


def main() -> int:
    if os.environ.get("CLUED_VERSION_CHECK", "").lower() == "off":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    event = payload.get("hook_event_name")
    try:
        if event == "SessionStart":
            text = session_report(payload)
        elif event == "PostToolUse":
            text = resume_report(payload)
        else:
            text = None
    except Exception as error:  # noqa: BLE001 - a broken check must not break the session
        text = f"BeamingFace version check could not run ({type(error).__name__}: {error})."
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
