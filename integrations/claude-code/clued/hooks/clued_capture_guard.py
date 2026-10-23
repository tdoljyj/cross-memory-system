#!/usr/bin/env python3
"""Claude Code Stop hook: enforce BeamingFace capture (BUG-20260924-001 L3).

protocol/agent/agent-contract.md §3 requires material outcomes to be
written to BeamingFace in the same turn, and §5 requires a checkpoint after writes.
This hook reads the session transcript when Claude is about to stop and blocks
the stop once, with a reason, when it finds:

* a material outcome (merged PR, by tool, `gh pr merge` or a `gh api` PUT to
  the merge endpoint; pushed main; applied migration; deployed edge function)
  with no committed BeamingFace write about it after it, including outcomes reached
  inside subagents, whose transcripts Claude Code keeps beside the session's
  (<session>/subagents/agent-*.jsonl) and which are merged in by timestamp;
* committed BeamingFace writes with no committed checkpoint for their context after
  them (BUG-20260924-003: a checkpoint absorbs only its own context's events,
  so project-scope writes need a checkpoint in that project's context);
* a human message that looks like an Owner decision with no committed BeamingFace
  write after it (every such message, not only the last one);
* an answered question (AskUserQuestion) with no committed BeamingFace write after
  it: Owner decisions are asked as such questions, so every answer counts as
  a decision, whatever its wording.

An Owner decision (a decision-looking message or an answer) is settled only by
a committed record write (clued_record_mutate, clued_decision_supersede or
clued_project_mutate). An Event (the legacy clued_append_event or an extension
clued_event_append) does not settle it: a decision kept only as an Event is
the gap that withheld every Global Decision on 2026-10-03 (Event 3951).

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
from datetime import datetime
from pathlib import Path

__version__ = "1.0.4"

CLUED_WRITE_TOOLS = (
    "clued_record_mutate",
    "clued_decision_supersede",
    "clued_project_mutate",
    "clued_evidence_ingest",
    "clued_event_append",
    "clued_append_event",
)
# The writes that create or change a Canonical Record; only these settle an
# Owner decision (§3).
RECORD_WRITE_TOOLS = (
    "clued_record_mutate",
    "clued_decision_supersede",
    "clued_project_mutate",
)
CLUED_CHECKPOINT_TOOL = "clued_session_checkpoint"
EVENT_ONLY_HINT = ("An Event (clued_append_event or clued_event_append) does not record it: write the "
                   "decision with clued_record_mutate (a decision record) or clued_decision_supersede "
                   "(§3, §4.1).")

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
# The REST merge endpoint merges only on PUT; a GET there just asks whether the
# PR is merged.
GH_API_MERGE = re.compile(
    COMMAND_START + r"gh\s+api\b(?=[^\n;&|]*(?:-X\s*|--method[=\s]+)['\"]?PUT\b)"
    r"[^\n;&|]*?/pulls/(\d+|\$\{?\w+\}?)/merge\b",
    re.MULTILINE | re.IGNORECASE)
# The GraphQL merge mutation names the PR by node id, so it has no PR number.
GH_GRAPHQL_MERGE = re.compile(COMMAND_START + r"gh\s+api\s+graphql\b[^\n;&|]*mergePullRequest",
                              re.MULTILINE | re.IGNORECASE)
# Tools whose command input runs a shell.
SHELL_TOOLS = ("Bash", "PowerShell")
# Host-injected reminders inside a human entry are not the Owner's words.
SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?(?:</system-reminder>|\Z)", re.DOTALL)
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
    record: bool = False  # a record write (RECORD_WRITE_TOOLS), not an Event or Evidence
    committed: bool = False
    detail: str = "no result"  # why it did not commit


@dataclass
class Subject:
    label: str
    patterns: list[re.Pattern]


# A BeamingFace write succeeded: record tools return "committed"; the legacy
# clued_append_event returns "appended" with a receipt.
WRITE_OK = ("committed", "appended")
# The tool that asks the Owner a question, and the text of an answered one:
# 'Your questions have been answered: "<question>"="<answer>", ...'
ASK_TOOL = "askuserquestion"
ANSWERED = re.compile(r"have been answered|answered (?:your|the) questions?", re.IGNORECASE)
ANSWER = re.compile(r'="((?:[^"\\]|\\.)*)"')


def owner_answers(entry: dict, body: str) -> str | None:
    """The Owner's answers to a question, or None when it was not answered.

    The Host's structured record (toolUseResult.answers) wins; the result text
    is the fallback, so a change of wording on either side is tolerated.
    """
    structured = entry.get("toolUseResult")
    structured = structured.get("answers") if isinstance(structured, dict) else None
    if isinstance(structured, dict) and structured:
        chosen = "; ".join(str(value) for value in structured.values())
    elif ANSWERED.search(body):
        chosen = "; ".join(ANSWER.findall(body)) or body.strip()
    else:
        return None
    return " ".join(chosen.split())[:120]
# Text of this hook's own reminders, should the Host log one as a user entry.
OWN_MESSAGE = "BeamingFace capture guard (protocol/agent/agent-contract.md"
PREVIOUS_OWN_MESSAGE = "KooYomi capture guard (protocol/agent/agent-contract.md"
EARLIER_OWN_MESSAGE = "Kooyumi capture guard (protocol/agent/agent-contract.md"
LEGACY_OWN_MESSAGE = "Clued capture guard (protocol/agent/agent-contract.md"
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


def load_session(path: Path) -> list[dict]:
    """The session transcript with its subagents' transcripts merged in.

    Claude Code keeps each subagent's transcript in <session>/subagents/; its
    entries carry isSidechain. They are merged into the session by parsed
    timestamp, so an outcome a subagent reaches is ordered against the
    session's later writes. An entry without a timestamp takes its file's
    previous one (or next one); a subagent file with none at all is placed
    last, so its outcomes need a write that is surely later. On equal times
    the session comes first. An entry repeated across files (same uuid) counts
    once. An unreadable subagent file is skipped, not fatal.
    """
    main = load_entries(path)
    try:
        subagent_files = sorted(path.with_suffix("").joinpath("subagents").glob("agent-*.jsonl"))
    except OSError:
        subagent_files = []
    if not subagent_files:
        return main
    files = [main]
    for file in subagent_files:
        try:
            files.append(load_entries(file))
        except OSError:
            continue
    keyed, seen = [], set()
    for rank, entries in enumerate(files):
        times = [parse_time(entry.get("timestamp")) for entry in entries]
        known = [t for t in times if t is not None]
        fill = known[0] if known else (float("-inf") if rank == 0 else float("inf"))
        for index, (entry, moment) in enumerate(zip(entries, times)):
            fill = moment if moment is not None else fill
            uuid = entry.get("uuid")
            if isinstance(uuid, str):
                if uuid in seen:
                    continue
                seen.add(uuid)
            keyed.append(((fill, rank, index), entry))
    return [entry for _, entry in sorted(keyed, key=lambda item: item[0])]


def parse_time(value) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def prompt_text(content) -> str | None:
    """Return the text of a user prompt, or None for tool results."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
    return None


def settle(writes: list[Write], after: int, subject: Subject | None,
           records_only: bool = False) -> tuple[str, str]:
    """How the BeamingFace writes after position `after` settle a finding.

    Returns ("settled", ""), ("none", ""), ("failed", detail) when writes were
    tried but none committed, or ("unrelated", "") when writes committed but
    none names the subject. With records_only (an Owner decision), only a
    record write settles it, and ("event_only", "") means that only Events or
    Evidence committed after it.
    """
    def names(write: Write) -> bool:
        return subject is None or any(p.search(write.text) for p in subject.patterns)

    later = [write for write in writes if write.pos > after]
    if records_only:
        records = [write for write in later if write.record]
        if any(write.committed for write in records):
            return ("settled", "")
        if records:
            return ("failed", records[-1].detail)
        if any(write.committed for write in later):
            return ("event_only", "")
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
    answers: list[tuple[int, str, str]] = []  # (position, use id, the Owner's answers)

    for pos, entry in enumerate(entries):
        # A subagent's outcomes and writes count; its "user" entries are the
        # parent's instructions, not the Owner's words.
        sidechain = bool(entry.get("isSidechain"))
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if entry.get("type") == "assistant" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    use_id, name = str(block.get("id", "")), str(block.get("name", ""))
                    tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
                    calls[use_id] = (pos, name, tool_input)
                    if tool_suffix(name) in CLUED_WRITE_TOOLS:
                        writes[use_id] = Write(pos, input_text(tool_input),
                                               record=tool_suffix(name) in RECORD_WRITE_TOOLS)
            continue
        if entry.get("type") != "user":
            continue
        text = prompt_text(content)
        if text is not None:
            origin = entry.get("origin")
            origin = origin.get("kind") if isinstance(origin, dict) else None
            human = not sidechain and (origin == "human" or (origin is None and not entry.get("isMeta")))
            # A compaction summary is the Host's recap, not something the Owner said.
            injected = entry.get("isCompactSummary") or entry.get("isVisibleInTranscriptOnly")
            text = SYSTEM_REMINDER.sub("", text)
            if human and not injected and not any(
                prefix in text for prefix in (OWN_MESSAGE, PREVIOUS_OWN_MESSAGE, EARLIER_OWN_MESSAGE, LEGACY_OWN_MESSAGE)
            ):
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
            elif suffix == ASK_TOOL and not failed:
                chosen = owner_answers(entry, body)
                if chosen is not None:
                    answers.append((pos, use_id, chosen))
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
            elif name in SHELL_TOOLS and not failed:
                command = HEREDOC.sub("", str(tool_input.get("command", "")))
                command = re.sub(r"\\\r?\n", " ", command)  # line continuations
                merges = gh_merge_numbers(command)
                for index, number in enumerate(merges):
                    outcomes.append((pos, f"{use_id}#{index}" if index else use_id,
                                     f"merged PR #{number} with gh pr merge" if number
                                     else "merged a PR with gh pr merge", pr_subject(number)))
                api_merges = []
                if '"merged":true' in body.replace(" ", "") or '"message"' not in body:
                    api_merges = [number if number.isdigit() else None
                                  for number in GH_API_MERGE.findall(command)]
                    api_merges += [None] * len(GH_GRAPHQL_MERGE.findall(command))
                for index, number in enumerate(api_merges):
                    outcomes.append((pos, f"{use_id}#api{index}", f"merged PR #{number} with gh api"
                                     if number else "merged a PR with gh api", pr_subject(number)))
                if not merges and not api_merges and GIT_PUSH_MAIN.search(command):
                    outcomes.append((pos, use_id, "pushed to main", None))

    ordered = sorted(writes.values(), key=lambda write: write.pos)
    findings: list[Finding] = []
    for pos, key, description, subject in outcomes:
        state, detail = settle(ordered, pos, subject)
        if state == "none":
            message = (f"- Material outcome with no BeamingFace write after it: {description}. "
                       "Record it per §3 (close or update the Task, or a follow-up note).")
        elif state == "failed":
            message = (f"- Material outcome not recorded: {description}. The BeamingFace write after it did "
                       f"not commit ({detail}). Fix and retry it; if BeamingFace or the Host refuses it, tell "
                       "the Owner which write is still owed (§4).")
        elif state == "unrelated":
            message = (f"- Material outcome not recorded: {description}. BeamingFace writes after it committed, "
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
                f"- {len(use_ids)} committed BeamingFace write(s) in context {context} since the last "
                f"checkpoint in that context. Resume with context_key={context}, reconcile, then "
                "clued_session_checkpoint with the same context_key and those writes' event IDs; "
                "a checkpoint never covers another context's events (§5)."
            )
        else:
            message = (
                f"- {len(use_ids)} committed BeamingFace write(s) since the last checkpoint. "
                "Reconcile if you wrote since resume, then clued_session_checkpoint (§5)."
            )
        findings.append(Finding(f"checkpoint:{context}:{use_ids[-1]}", message))
    for pos, use_id, chosen in answers:
        state, detail = settle(ordered, pos, None, records_only=True)
        if state == "none":
            findings.append(Finding(
                f"answer:{use_id}",
                f"- The Owner answered a question (“{chosen}”) and no BeamingFace write followed. An Owner "
                "choice is a decision per §3: record it; if this answer needs no record, say why.",
            ))
        elif state == "failed":
            findings.append(Finding(
                f"answer:{use_id}:failed",
                f"- The Owner answered a question (“{chosen}”) and the BeamingFace write after it did not "
                f"commit ({detail}). If the answer needs a record, fix and retry the write; if BeamingFace or "
                "the Host refuses it, tell the Owner which write is still owed (§4). If it needs no "
                "record, say why.",
            ))
        elif state == "event_only":
            findings.append(Finding(
                f"answer:{use_id}:event_only",
                f"- The Owner answered a question (“{chosen}”) and only an Event followed. "
                f"{EVENT_ONLY_HINT} If it needs no record, say why.",
            ))
    # Every message that looks like a decision, not only the last: a committed
    # write after a message settles it, so in practice these are the messages
    # since the last committed write.
    for pos, key, text in human_prompts:
        match = DECISION_PATTERN.search(text)
        if not match:
            continue
        state, detail = settle(ordered, pos, None, records_only=True)
        quote = " ".join(text.split())[:60]
        if state == "none":
            findings.append(Finding(
                f"decision:{key}",
                f"- An Owner message may be a decision (matched “{match.group(0)}” in “{quote}”). "
                "If it is a material decision per §3, record it; if not, no record is needed.",
            ))
        elif state == "failed":
            findings.append(Finding(
                f"decision:{key}:failed",
                f"- An Owner message may be a decision (matched “{match.group(0)}” in “{quote}”) and "
                f"the BeamingFace write after it did not commit ({detail}). Fix and retry it; if BeamingFace or "
                "the Host refuses it, tell the Owner which write is still owed (§4).",
            ))
        elif state == "event_only":
            findings.append(Finding(
                f"decision:{key}:event_only",
                f"- An Owner message may be a decision (matched “{match.group(0)}” in “{quote}”) and "
                f"only an Event followed. {EVENT_ONLY_HINT} If it is not a material decision, no "
                "record is needed.",
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
    findings = analyse(load_session(Path(transcript)))
    path = state_path(str(payload.get("session_id", "")))
    reported = load_reported(path)
    new = [finding for finding in findings if finding.key not in reported]
    if not new:
        return 0
    save_reported(path, reported | {finding.key for finding in new})
    print(
        "BeamingFace capture guard (protocol/agent/agent-contract.md §3 and §5):\n"
        + "\n".join(finding.message for finding in new)
        + "\nHandle these now, or say in your reply why they need no record or that BeamingFace is "
        "unavailable. Each item is reported once in each state.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
