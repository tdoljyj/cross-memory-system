#!/usr/bin/env python3
"""Claude Code Stop hook: enforce Clued capture (BUG-20260924-001 L3).

skills/clued/references/agent-contract.md §3 requires material outcomes to be
written to Clued in the same turn, and §5 requires a checkpoint after writes.
This hook reads the session transcript when Claude is about to stop and blocks
the stop once, with a reason, when it finds:

* a material outcome (merged PR, pushed main, applied migration, deployed edge
  function) with no Clued write attempted after it;
* committed Clued writes with no committed checkpoint for their context after
  them (BUG-20260924-003: a checkpoint absorbs only its own context's events,
  so project-scope writes need a checkpoint in that project's context);
* a human message that looks like an Owner decision with no Clued write
  attempted after it.

Each finding is reported at most once per session (state is kept in the temp
directory), so the hook never loops. Set CLUED_CAPTURE_GUARD=off to disable.
Exit 0 allows the stop; exit 2 with a stderr reason blocks it.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

CLUED_WRITE_TOOLS = (
    "clued_record_mutate",
    "clued_decision_supersede",
    "clued_project_mutate",
    "clued_evidence_ingest",
    "clued_event_append",
    "clued_append_event",
)
CLUED_CHECKPOINT_TOOL = "clued_session_checkpoint"

DECISION_PATTERN = re.compile(
    r"(接受|同意|批准|决定|就这样|就按|就用|选用|暂缓|先不(做|要|考虑|推)|不做了|不再|取消|冻结|解冻"
    r"|保持原样|改成|改为|缩小|扩大|放弃|以后都|今后|从现在起|优先"
    r"|\bapprove[sd]?\b|\baccept(ed|s)?\b|\breject(ed|s)?\b|\bgo with\b|\bdecided?\b"
    r"|\bfrom now on\b|\bdefer(red)?\b|\bcancel(led)?\b)",
    re.IGNORECASE,
)
# Only an invocation counts: the command must start a line or follow a shell
# separator, so text such as a commit message that mentions it does not match.
COMMAND_START = r"(?:^|[;&|(]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*"
GIT_PUSH_MAIN = re.compile(COMMAND_START + r"git\s+push\b[^\n;&|]*\b(main|master)\b", re.MULTILINE)
GH_PR_MERGE = re.compile(COMMAND_START + r"gh\s+pr\s+merge\b", re.MULTILINE)
# Heredoc bodies (commit messages, inline scripts) are data, not commands.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?^\s*\2\s*$", re.MULTILINE | re.DOTALL)


@dataclass
class Finding:
    key: str
    message: str


def tool_suffix(name: str) -> str:
    return name.rsplit("__", 1)[-1].lower() if name else ""


def result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def result_body(text: str) -> dict:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def result_status(text: str) -> str | None:
    return result_body(text).get("status")


def write_context(tool_input: dict) -> str | None:
    """The checkpoint context a write belongs to, or None when unknown."""
    for key in ("scope", "context_key"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def checkpoint_context(tool_input: dict, body: str) -> str:
    """The context a committed checkpoint absorbed events in.

    The server resolves an omitted context_key from the session token and
    always returns the context it committed in, so the result wins over the
    input; "global" is only the fallback for results that do not carry it.
    """
    value = result_body(body).get("context_key")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return write_context(tool_input) or "global"


def load_entries(path: Path) -> list[dict]:
    entries = []
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue  # the line being written right now may be incomplete
    return entries


def prompt_text(content) -> str | None:
    """Return the text of a user prompt, or None for tool results."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
    return None


def analyse(entries: list[dict]) -> list[Finding]:
    calls: dict[str, tuple[int, str, dict]] = {}
    outcomes: list[tuple[int, str, str]] = []  # (position, key, description)
    write_attempts: list[int] = []
    committed_writes: list[tuple[int, str, str | None]] = []  # (position, use id, context)
    checkpoints: list[tuple[int, str]] = []  # (position, context)
    human_prompts: list[tuple[int, str, str]] = []  # (position, key, text)

    for pos, entry in enumerate(entries):
        if entry.get("isSidechain"):
            continue
        message = entry.get("message") or {}
        content = message.get("content")
        if entry.get("type") == "assistant" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    calls[block.get("id", "")] = (pos, block.get("name", ""), block.get("input") or {})
                    if tool_suffix(block.get("name", "")) in CLUED_WRITE_TOOLS:
                        write_attempts.append(pos)
            continue
        if entry.get("type") != "user":
            continue
        text = prompt_text(content)
        if text is not None:
            origin = (entry.get("origin") or {}).get("kind")
            if origin == "human" or (origin is None and not entry.get("isMeta")):
                human_prompts.append((pos, entry.get("uuid") or f"pos{pos}", text))
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            use_id = block.get("tool_use_id", "")
            if use_id not in calls:
                continue
            _, name, tool_input = calls[use_id]
            suffix = tool_suffix(name)
            body = result_text(block.get("content"))
            failed = bool(block.get("is_error"))
            if suffix in CLUED_WRITE_TOOLS and not failed and result_status(body) == "committed":
                committed_writes.append((pos, use_id, write_context(tool_input)))
            elif suffix == CLUED_CHECKPOINT_TOOL and not failed and result_status(body) == "committed":
                checkpoints.append((pos, checkpoint_context(tool_input, body)))
            elif suffix == "merge_pull_request" and not failed and '"merged":true' in body.replace(" ", ""):
                number = tool_input.get("pullNumber", "?")
                repo = f"{tool_input.get('owner', '')}/{tool_input.get('repo', '')}".strip("/")
                outcomes.append((pos, use_id, f"merged PR {repo}#{number}"))
            elif suffix == "apply_migration" and not failed and '"error"' not in body:
                outcomes.append((pos, use_id, f"applied migration {tool_input.get('name', '')}".strip()))
            elif suffix == "deploy_edge_function" and not failed and '"error"' not in body:
                outcomes.append((pos, use_id, f"deployed edge function {tool_input.get('name', '')}".strip()))
            elif name == "Bash" and not failed:
                command = HEREDOC.sub("", str(tool_input.get("command", "")))
                if GH_PR_MERGE.search(command):
                    outcomes.append((pos, use_id, "merged a PR with gh pr merge"))
                elif GIT_PUSH_MAIN.search(command):
                    outcomes.append((pos, use_id, "pushed to main"))

    findings: list[Finding] = []
    for pos, key, description in outcomes:
        if not any(attempt > pos for attempt in write_attempts):
            findings.append(Finding(
                f"outcome:{key}",
                f"- Material outcome with no Clued write after it: {description}. "
                "Record it per §3 (close or update the Task, or a follow-up note).",
            ))
    # A write is settled by a later checkpoint in its own context; a write whose
    # context is unknown is settled by any later checkpoint.
    pending: dict[str, list[str]] = {}
    for pos, use_id, context in committed_writes:
        if not any(cp_pos > pos and (context is None or cp_context == context)
                   for cp_pos, cp_context in checkpoints):
            pending.setdefault(context or "", []).append(use_id)
    for context, use_ids in pending.items():
        if context:
            message = (
                f"- {len(use_ids)} committed Clued write(s) in context {context} since the last "
                f"checkpoint in that context. Resume with context_key={context}, reconcile, then "
                "clued_session_checkpoint with the same context_key and those writes' event IDs; "
                "a checkpoint never covers another context's events (§5)."
            )
        else:
            message = (
                f"- {len(use_ids)} committed Clued write(s) since the last checkpoint. "
                "Reconcile if you wrote since resume, then clued_session_checkpoint (§5)."
            )
        findings.append(Finding(f"checkpoint:{context}:{use_ids[-1]}", message))
    if human_prompts:
        pos, key, text = human_prompts[-1]
        match = DECISION_PATTERN.search(text)
        if match and not any(attempt > pos for attempt in write_attempts):
            findings.append(Finding(
                f"decision:{key}",
                f"- The Owner's last message may be a decision (matched “{match.group(0)}”). "
                "If it is a material decision per §3, record it; if not, no record is needed.",
            ))
    return findings


def state_path(session_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "unknown")
    return Path(tempfile.gettempdir()) / "clued-capture-guard" / f"{safe}.json"


def load_reported(path: Path) -> set[str]:
    try:
        return set(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return set()


def save_reported(path: Path, keys: set[str]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(keys)), encoding="utf-8")
    except OSError:
        pass


def main() -> int:
    if os.environ.get("CLUED_CAPTURE_GUARD", "").lower() == "off":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    transcript = payload.get("transcript_path")
    if not transcript or not Path(transcript).is_file():
        return 0
    findings = analyse(load_entries(Path(transcript)))
    path = state_path(str(payload.get("session_id", "")))
    reported = load_reported(path)
    new = [finding for finding in findings if finding.key not in reported]
    if not new:
        return 0
    save_reported(path, reported | {finding.key for finding in new})
    print(
        "Clued capture guard (skills/clued/references/agent-contract.md §3 and §5):\n"
        + "\n".join(finding.message for finding in new)
        + "\nHandle these now, or say in your reply why they need no record or that Clued is "
        "unavailable. Each item is reported once.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
