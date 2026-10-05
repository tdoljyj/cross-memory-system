#!/usr/bin/env python3
"""Claude Code hooks for Clued work claims (Work Claim Admission step 6, L3).

development/contracts/execution-admission/WorkClaimAdmission.v0.1.md §4.6 L3 and
skills/clued/references/agent-contract.md §1.7: claim the active Task with
clued_work_claim before spending on work. One script serves three hook events,
chosen by the payload's hook_event_name:

* SessionStart adds the claim rule to the first turn's context, with the live
  claims this checkout recorded and, when CLUED_CONTEXT_READ_TOKEN holds a
  read-only Binding token, the user's live claims read from Clued.
* PostToolUse on clued_work_claim / renew / takeover / release records the
  returned claim in $CLAUDE_PROJECT_DIR/.clued/work-claim.json (gitignored).
* PreToolUse blocks the call once per session and kind when no live claim is
  recorded and CLUED_WORK_CLAIM is unset. Kinds: publish (git push, gh pr
  create, the GitHub PR and file-push tools), spend (installs, builds, tests,
  npm run and npx scripts, gh workflow run / gh run rerun, the GitHub
  workflow-dispatch tool, a remote session, a Workflow or a non-read-only
  Agent subtask) and edit (Edit, Write or NotebookEdit on a repository file).

This is the compliance layer: it can be turned off (CLUED_WORK_CLAIM_GUARD=off),
reports each kind once, and never claims to make anything unbypassable. The
enforced check is clued-work-admission in CI. SessionStart and PostToolUse
always exit 0; PreToolUse exits 2 with a stderr reason to block.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

__version__ = "1.0.0"

CLAIM_FILE = Path(".clued") / "work-claim.json"
PUBLIC_CONFIG_SOURCE = Path("apps/clued-cloud/app/supabase-public-config.ts")
ACTIVE_RPC = "clued_work_claims_active_v1"
LIVE_STATUSES = {"ACTIVE", "DRAINING"}
CLAIM_TOOLS = {"clued_work_claim", "clued_work_renew", "clued_work_takeover", "clued_work_release"}
PUBLISH_TOOLS = {"create_pull_request", "push_files", "create_or_update_file"}
# Starting CI or dispatching a subtask spends like a build (agent-contract §1.7).
SPEND_TOOLS = {"actions_run_trigger", "create_session"}
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
# Read-only helpers a session uses to find its way; they are not a subtask.
READ_ONLY_AGENTS = {"explore", "plan", "claude-code-guide", "statusline-setup"}

# Only an invocation counts: the command must start a line or follow a shell
# separator, so text such as a commit message that mentions it does not match.
COMMAND_START = r"(?:^|[;&|(]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*"
PUBLISH_COMMAND = re.compile(COMMAND_START + r"(?:git\s+push|gh\s+pr\s+create)\b", re.MULTILINE)
SPEND_COMMAND = re.compile(
    COMMAND_START
    + r"(?:(?:npm|pnpm|yarn)\s+(?:ci|install|i|add|test|t|run\s+[\w:.-]+)\b"
    r"|npx\s+(?:-\S+\s+)*[\w@./-]+"
    r"|gh\s+(?:workflow\s+run|run\s+rerun)\b"
    r"|node\s+--test\b"
    r"|pip3?\s+install\b"
    r"|(?:python3?\s+-m\s+)?pytest\b"
    r"|python3?\s+-m\s+unittest\b"
    r"|(?:cargo|go)\s+(?:build|test)\b)",
    re.MULTILINE,
)
# Heredoc bodies (commit messages, inline scripts) are data, not commands.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?^\s*\2\s*$", re.MULTILINE | re.DOTALL)
PUBLIC_CONFIG = re.compile(r'return \{ url: "(https://[^"]+)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};')

RULE = (
    "Clued work claims (skills/clued/references/agent-contract.md §1.7): before work that changes "
    "repository files, runs an install, build or test, starts CI, opens a pull request or dispatches "
    "a subtask, claim its active Task with clued_work_claim (write_set = the paths you will change). "
    "On work_claim_conflict stop and tell the Owner who holds it; never retry under another title, "
    "Task, key or Binding. Put `Clued-Work-Claim: <claim_id>` in the pull request body and the head "
    "commit: clued-work-admission enforces it on pull requests to main. Renew before the lease ends "
    "and release when the work ends."
)


def tool_suffix(name: str) -> str:
    return name.rsplit("__", 1)[-1].lower() if name else ""


def project_dir(payload: dict) -> Path:
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or ".")


def parse_time(value) -> datetime | None:
    """ISO timestamps from Postgres, whose fraction may have fewer than 6 digits."""
    if not isinstance(value, str):
        return None
    match = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$", value.strip())
    if not match:
        return None
    date, clock, fraction, zone = match.groups()
    fraction = (fraction or "0")[:6].ljust(6, "0")
    zone = "+00:00" if zone in (None, "Z") else (zone if ":" in zone else zone[:3] + ":" + zone[3:])
    try:
        return datetime.fromisoformat(f"{date}T{clock}.{fraction}{zone}")
    except ValueError:
        return None


def is_live(claim: dict, now: datetime) -> bool:
    expires = parse_time(claim.get("expires_at"))
    return claim.get("status") in LIVE_STATUSES and expires is not None and expires > now


def load_claims(path: Path) -> dict[str, dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    claims = data.get("claims") if isinstance(data, dict) else None
    return {k: v for k, v in claims.items() if isinstance(v, dict)} if isinstance(claims, dict) else {}


def save_claims(path: Path, claims: dict[str, dict]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"claims": claims}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def response_body(response) -> dict | None:
    """The tool result object, whatever shape the Host passes it in."""
    if isinstance(response, dict):
        if isinstance(response.get("structuredContent"), dict):
            return response["structuredContent"]
        if "status" in response:
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


def record_claim(payload: dict) -> None:
    if tool_suffix(payload.get("tool_name", "")) not in CLAIM_TOOLS:
        return
    body = response_body(payload.get("tool_response"))
    claim = body.get("claim") if isinstance(body, dict) and body.get("status") == "committed" else None
    if not isinstance(claim, dict) or not isinstance(claim.get("claim_id"), str):
        return
    path = project_dir(payload) / CLAIM_FILE
    claims = load_claims(path)
    replaced = (payload.get("tool_input") or {}).get("claim_id")
    if tool_suffix(payload.get("tool_name", "")) == "clued_work_takeover" and isinstance(replaced, str):
        claims.pop(replaced, None)
    if claim.get("status") in LIVE_STATUSES:
        kept = {key: claim.get(key) for key in ("claim_id", "task_id", "context_key", "fence",
                                                 "lease_version", "status", "expires_at",
                                                 "write_set", "base_commit")}
        claims[claim["claim_id"]] = {**kept, "session_id": payload.get("session_id")}
    else:
        claims.pop(claim["claim_id"], None)
    save_claims(path, claims)


def guarded_kind(payload: dict) -> str | None:
    name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if name == "Bash":
        command = HEREDOC.sub("", str(tool_input.get("command", "")))
        if PUBLISH_COMMAND.search(command):
            return "publish"
        if SPEND_COMMAND.search(command):
            return "spend"
        return None
    if name.startswith("mcp__") and tool_suffix(name) in PUBLISH_TOOLS:
        return "publish"
    if name.startswith("mcp__") and tool_suffix(name) in SPEND_TOOLS:
        return "spend"
    if name == "Workflow":
        return "spend"
    if name == "Agent":
        kind = str(tool_input.get("subagent_type") or "general-purpose").strip().lower()
        return None if kind in READ_ONLY_AGENTS else "spend"
    if name in EDIT_TOOLS:
        return "edit" if in_repository(payload, tool_input) else None
    return None


def in_repository(payload: dict, tool_input: dict) -> bool:
    raw = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not raw:
        return False
    root = project_dir(payload).resolve()
    path = Path(str(raw))
    target = (path if path.is_absolute() else root / path).resolve()
    try:
        relative = target.relative_to(root)
    except ValueError:
        return False
    return bool(relative.parts) and relative.parts[0] not in {".clued", ".git"}


def state_path(session_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "unknown")
    return Path(tempfile.gettempdir()) / "clued-work-claim-guard" / f"{safe}.json"


def check_claim(payload: dict) -> int:
    kind = guarded_kind(payload)
    if kind is None or os.environ.get("CLUED_WORK_CLAIM", "").strip():
        return 0
    now = datetime.now(timezone.utc)
    if any(is_live(c, now) for c in load_claims(project_dir(payload) / CLAIM_FILE).values()):
        return 0
    path = state_path(str(payload.get("session_id", "")))
    try:
        reported = set(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        reported = set()
    if kind in reported:
        return 0
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(reported | {kind})), encoding="utf-8")
    except OSError:
        pass
    if kind == "publish":
        what = ("This pushes or opens a pull request. clued-work-admission is enforced on main, so a pull "
                "request without `Clued-Work-Claim: <claim_id>` in its body and head commit is rejected.")
    elif kind == "edit":
        what = "This changes a repository file, which is work on a Task."
    else:
        what = ("This runs an install, build or test, starts CI or dispatches a subtask, which is spending "
                "on the work.")
    print(
        "Clued work-claim guard (agent-contract §1.7): no live work claim is recorded for this checkout. "
        + what
        + " Claim the active Task with clued_work_claim first (the claim is recorded automatically), "
        "or set CLUED_WORK_CLAIM=<claim_id> if you hold one from elsewhere. If the work-claim tools are "
        "not offered to this session, say so to the Owner and continue. This is reported once per "
        "session for this kind of call.",
        file=sys.stderr,
    )
    return 2


def public_config(root: Path) -> tuple[str, str] | None:
    url, key = os.environ.get("CLUED_SUPABASE_URL"), os.environ.get("CLUED_SUPABASE_PUBLISHABLE_KEY")
    if not (url and key):
        try:
            match = PUBLIC_CONFIG.search((root / PUBLIC_CONFIG_SOURCE).read_text(encoding="utf-8"))
        except OSError:
            return None
        if not match:
            return None
        url, key = match.groups()
    loopback = re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", url.rstrip("/"))
    if not (url.startswith("https://") or loopback):
        return None
    return url.rstrip("/"), key


def fetch_live_claims(root: Path, token: str) -> list[dict] | str:
    config = public_config(root)
    if config is None:
        return "the public Clued database config could not be read"
    url, key = config
    body = json.dumps({"p_token_hash": hashlib.sha256(token.encode()).hexdigest(),
                       "p_input": {"scope": "global"}}).encode()
    request = urllib.request.Request(
        f"{url}/rest/v1/rpc/{ACTIVE_RPC}", data=body, method="POST",
        headers={"apikey": key, "authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            data = json.loads(response.read().decode())
    except Exception as error:  # noqa: BLE001 - any failure only degrades the reminder
        return f"reading live claims failed ({type(error).__name__})"
    claims = data.get("active_work_claims") if isinstance(data, dict) else None
    return [c for c in claims if isinstance(c, dict)] if isinstance(claims, list) else "no claims list returned"


def describe(claim: dict) -> str:
    paths = [p for p in claim.get("write_set") or [] if isinstance(p, str)]
    shown = ", ".join(paths[:8]) + (f" (+{len(paths) - 8} more)" if len(paths) > 8 else "")
    holder = claim.get("holder_session_ref") or claim.get("session_id") or "unknown session"
    return (f"- claim {claim.get('claim_id')} on Task {claim.get('task_id')} by {holder}, "
            f"until {claim.get('expires_at')}: {shown or 'no paths'}")


def session_context(payload: dict) -> str:
    root = project_dir(payload)
    now = datetime.now(timezone.utc)
    lines = [RULE]
    local = [c for c in load_claims(root / CLAIM_FILE).values() if is_live(c, now)]
    if local:
        lines.append("Live claims recorded in this checkout:")
        lines += [describe(c) for c in local[:10]]
    token = os.environ.get("CLUED_CONTEXT_READ_TOKEN", "").strip()
    if token:
        live = fetch_live_claims(root, token)
        if isinstance(live, str):
            lines.append(f"Live claims from Clued are unavailable: {live}. clued_session_resume lists them.")
        elif live:
            lines.append("Live claims in Clued (check these before you start; do not overlap them):")
            lines += [describe(c) for c in live[:10]]
        else:
            lines.append("Clued reports no live claims.")
    else:
        lines.append("clued_session_resume lists the live claims (active_work_claims); check them before you start.")
    return "\n".join(lines)


def main() -> int:
    if os.environ.get("CLUED_WORK_CLAIM_GUARD", "").lower() == "off":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    event = payload.get("hook_event_name")
    if event == "PreToolUse":
        return check_claim(payload)
    if event == "PostToolUse":
        record_claim(payload)
        return 0
    if event == "SessionStart":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": session_context(payload)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
