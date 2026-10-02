#!/usr/bin/env python3
"""Claude Code Stop hook: enforce Clued capture (BUG-20260924-001 L3).

skills/clued/references/agent-contract.md §3 requires material outcomes to be
written to Clued in the same turn, and §5 requires a checkpoint after writes.
This hook reads the session transcript when Claude is about to stop and blocks
the stop once, with a reason, when it finds:

* a material outcome (merged PR, pushed main, applied migration, deployed edge
  function) with no committed Clued write about it after it;
* committed Clued writes with no committed checkpoint for their context after
  them (BUG-20260924-003: a checkpoint absorbs only its own context's events,
  so project-scope writes need a checkpoint in that project's context);
* a human message that looks like an Owner decision with no committed Clued
  write after it.

Only a write whose result is committed (or "appended", for the legacy event
tool) settles a finding: a rejected, failed or unanswered write does not. A
write is about an outcome when its input names the outcome's subject (the PR
number or merge commit, the migration or the function); a push to main has no
subject, so any committed write settles it. An appended event, like any
committed write, also needs a checkpoint (§5).

Each finding is reported at most once per session per state (no write, write
not committed, write not about it), with state kept in the temp directory, so
the hook never loops. Set CLUED_CAPTURE_GUARD=off to disable.
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


@dataclass
class Write:
    pos: int
    text: str  # the string values of the call's input, for subject matching
    committed: bool = False
    detail: str = "no result"  # why it did not commit


@dataclass
class Subject:
    label: str
    patterns: list[re.Pattern]


# A Clued write succeeded: record tools return "committed"; the legacy
# clued_append_event returns "appended" with a receipt.
WRITE_OK = ("committed", "appended")
# Text of this hook's own reminders, should the Host log one as a user entry.
OWN_MESSAGE = "Clued capture guard (skills/clued/references/agent-contract.md"
# `gh pr merge` options that take a value.
GH_VALUE_OPTIONS = {"-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file",
                    "-A", "--author-email", "--match-head-commit"}


def input_text(value) -> str:
    """The string and number values of a tool input, NUL-separated so that no
    pattern matches across two values."""
    if isinstance(value, dict):
        return "\0".join(input_text(item) for item in value.values())
    if isinstance(value, list):
        return "\0".join(input_text(item) for item in value)
    return "" if value is None or isinstance(value, bool) else str(value)


def pr_subject(number, sha=None) -> Subject | None:
    patterns, number = [], str(number)
    if number.isdigit():
        patterns.append(re.compile(
            rf"(?:[#＃]|/pull/|(?<![A-Za-z])pr[\s:#＃-]*|pull request\s*#?){number}(?![0-9A-Za-z])",
            re.IGNORECASE))
    if isinstance(sha, str) and len(sha) >= 7:
        patterns.append(re.compile(re.escape(sha[:7]), re.IGNORECASE))
    if not patterns:
        return None
    return Subject(f"PR #{number}" if number.isdigit() else f"merge commit {sha[:7]}", patterns)


def name_subject(kind: str, name) -> Subject | None:
    if not isinstance(name, str) or not name.strip():
        return None
    return Subject(f"{kind} {name.strip()}", [re.compile(re.escape(name.strip()), re.IGNORECASE)])


def gh_merge_numbers(command: str) -> list[str | None]:
    """One entry per `gh pr merge` in the command: its PR number, or None."""
    command = re.sub(r"\\\r?\n", " ", command)
    numbers: list[str | None] = []
    for match in GH_PR_MERGE.finditer(command):
        tokens = re.split(r"[;&|\n)]", command[match.end():], maxsplit=1)[0].split()
        number, skip = None, False
        for token in tokens:
            if skip:
                skip = False
                continue
            if token.startswith("-"):
                skip = token in GH_VALUE_OPTIONS
                continue
            token = token.strip("'\"")
            found = re.fullmatch(r"#?(\d+)", token) or re.search(r"/pull/(\d+)", token)
            number = found.group(1) if found else None
            break
        numbers.append(number)
    return numbers


def failure_detail(body: str, is_error: bool) -> str:
    data = result_body(body)
    error = data.get("error_code") or data.get("error")
    if isinstance(error, dict):
        error = error.get("code") or error.get("message")
    parts = [str(value) for value in (data.get("status"), error) if value]
    if parts:
        return ": ".join(dict.fromkeys(parts))[:80]
    text = " ".join(body.split())[:80]
    return text or ("tool error" if is_error else "empty result")


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
                entry = json.loads(line)
            except ValueError:
                continue  # the line being written right now may be incomplete
            if isinstance(entry, dict):
                entries.append(entry)
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


def settle(writes: list[Write], after: int, subject: Subject | None) -> tuple[str, str]:
    """How the Clued writes after position `after` settle a finding.

    Returns ("settled", ""), ("none", ""), ("failed", detail) when writes were
    tried but none committed, or ("unrelated", "") when writes committed but
    none names the subject.
    """
    def names(write: Write) -> bool:
        return subject is None or any(p.search(write.text) for p in subject.patterns)

    later = [write for write in writes if write.pos > after]
    committed = [write for write in later if write.committed]
    if not committed:
        if not later:
            return ("none", "")
        # Report the failure of the write about this subject, if there was one.
        about = [write for write in later if names(write)] or later
        return ("failed", about[-1].detail)
    return ("settled", "") if any(names(write) for write in committed) else ("unrelated", "")


def analyse(entries: list[dict]) -> list[Finding]:
    calls: dict[str, tuple[int, str, dict]] = {}
    outcomes: list[tuple[int, str, str, Subject | None]] = []  # (position, key, description, subject)
    writes: dict[str, Write] = {}
    committed_writes: list[tuple[int, str, str | None]] = []  # (position, use id, context)
    checkpoints: list[tuple[int, str]] = []  # (position, context)
    human_prompts: list[tuple[int, str, str]] = []  # (position, key, text)

    for pos, entry in enumerate(entries):
        if entry.get("isSidechain"):
            continue
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if entry.get("type") == "assistant" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    use_id, name = str(block.get("id", "")), str(block.get("name", ""))
                    tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
                    calls[use_id] = (pos, name, tool_input)
                    if tool_suffix(name) in CLUED_WRITE_TOOLS:
                        writes[use_id] = Write(pos, input_text(tool_input))
            continue
        if entry.get("type") != "user":
            continue
        text = prompt_text(content)
        if text is not None:
            origin = entry.get("origin")
            origin = origin.get("kind") if isinstance(origin, dict) else None
            human = origin == "human" or (origin is None and not entry.get("isMeta"))
            if human and OWN_MESSAGE not in text:
                human_prompts.append((pos, str(entry.get("uuid") or f"pos{pos}"), text))
            continue
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            use_id = str(block.get("tool_use_id", ""))
            if use_id not in calls:
                continue
            _, name, tool_input = calls[use_id]
            suffix = tool_suffix(name)
            body = result_text(block.get("content"))
            failed = bool(block.get("is_error"))
            if suffix in CLUED_WRITE_TOOLS:
                write = writes[use_id]
                if not failed and result_status(body) in WRITE_OK:
                    write.committed = True
                    committed_writes.append((pos, use_id, write_context(tool_input)))
                else:
                    write.detail = failure_detail(body, failed)
            elif suffix == CLUED_CHECKPOINT_TOOL and not failed and result_status(body) == "committed":
                checkpoints.append((pos, checkpoint_context(tool_input, body)))
            elif suffix == "merge_pull_request" and not failed and '"merged":true' in body.replace(" ", ""):
                number = next((tool_input[k] for k in ("pullNumber", "pull_number", "number")
                               if k in tool_input), "?")
                repo = f"{tool_input.get('owner', '')}/{tool_input.get('repo', '')}".strip("/")
                outcomes.append((pos, use_id, f"merged PR {repo}#{number}",
                                 pr_subject(number, result_body(body).get("sha"))))
            elif suffix == "apply_migration" and not failed and '"error"' not in body:
                outcomes.append((pos, use_id, f"applied migration {tool_input.get('name', '')}".strip(),
                                 name_subject("migration", tool_input.get("name"))))
            elif suffix == "deploy_edge_function" and not failed and '"error"' not in body:
                outcomes.append((pos, use_id, f"deployed edge function {tool_input.get('name', '')}".strip(),
                                 name_subject("edge function", tool_input.get("name"))))
            elif name == "Bash" and not failed:
                command = HEREDOC.sub("", str(tool_input.get("command", "")))
                merges = gh_merge_numbers(command)
                for index, number in enumerate(merges):
                    outcomes.append((pos, f"{use_id}#{index}" if index else use_id,
                                     f"merged PR #{number} with gh pr merge" if number
                                     else "merged a PR with gh pr merge", pr_subject(number)))
                if not merges and GIT_PUSH_MAIN.search(command):
                    outcomes.append((pos, use_id, "pushed to main", None))

    ordered = sorted(writes.values(), key=lambda write: write.pos)
    findings: list[Finding] = []
    for pos, key, description, subject in outcomes:
        state, detail = settle(ordered, pos, subject)
        if state == "none":
            message = (f"- Material outcome with no Clued write after it: {description}. "
                       "Record it per §3 (close or update the Task, or a follow-up note).")
        elif state == "failed":
            message = (f"- Material outcome not recorded: {description}. The Clued write after it did "
                       f"not commit ({detail}). Fix and retry it; if Clued or the Host refuses it, tell "
                       "the Owner which write is still owed (§4).")
        elif state == "unrelated":
            message = (f"- Material outcome not recorded: {description}. Clued writes after it committed, "
                       f"but none names {subject.label}. Record this outcome itself per §3 and cite "
                       f"{subject.label} in the record.")
        else:
            continue
        # "none" keeps the key earlier versions used, so an upgrade does not re-report it.
        findings.append(Finding(f"outcome:{key}" if state == "none" else f"outcome:{key}:{state}", message))
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
        state, detail = settle(ordered, pos, None) if match else ("settled", "")
        if state == "none":
            findings.append(Finding(
                f"decision:{key}",
                f"- The Owner's last message may be a decision (matched “{match.group(0)}”). "
                "If it is a material decision per §3, record it; if not, no record is needed.",
            ))
        elif state == "failed":
            findings.append(Finding(
                f"decision:{key}:failed",
                f"- The Owner's last message may be a decision (matched “{match.group(0)}”) and the "
                f"Clued write after it did not commit ({detail}). Fix and retry it; if Clued or the "
                "Host refuses it, tell the Owner which write is still owed (§4).",
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
        return run()
    except Exception:  # an odd transcript must never break the session
        return 0


def run() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
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
        "unavailable. Each item is reported once in each state.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
