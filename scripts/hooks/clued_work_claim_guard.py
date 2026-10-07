#!/usr/bin/env python3
"""Claude Code hooks for Clued work claims (Work Claim Admission step 6, L3).

development/contracts/execution-admission/WorkClaimAdmission.v0.1.md §4.6 L3 and
skills/clued/references/agent-contract.md §1.7: claim the active Task with
clued_work_claim before spending on work, and answer the other Agents that
write to you about it (AgentMessaging.v0.1 step 2). One script serves four hook
events, chosen by the payload's hook_event_name:

* SessionStart adds the claim rule to the first turn's context, with the live
  claims this checkout recorded and, when CLUED_CONTEXT_READ_TOKEN holds a
  read-only Binding token, the user's live claims read from Clued.
* PostToolUse on clued_work_claim / renew / takeover / release records the
  returned claim in $CLAUDE_PROJECT_DIR/.clued/work-claim.json (gitignored).
  On clued_session_resume and clued_work_renew whose agent_inbox reports
  unread messages or unanswered requests, it adds a reminder to read and
  answer them.
* PreToolUse blocks the call once per session and kind when no live claim is
  recorded and CLUED_WORK_CLAIM is unset. Kinds: publish (git push, gh pr
  create, the GitHub PR and file-push tools), spend (installs, builds, tests,
  npm run and npx scripts, gh workflow run / gh run rerun, the GitHub
  workflow-dispatch tool, a remote session, a Workflow or a non-read-only
  Agent subtask) and edit (Edit, Write or NotebookEdit on a repository file).
* Stop reads the transcript (no network): when the latest agent_inbox from a
  resume or renewal reported messages and no clued_agent_inbox read followed
  it, or reported requests and no committed clued_agent_message_send reply
  followed it, it blocks the stop once per report and state.

This is the compliance layer: it can be turned off (CLUED_WORK_CLAIM_GUARD=off),
reports each kind once, and never claims to make anything unbypassable. The
enforced check is clued-work-admission in CI. SessionStart and PostToolUse
always exit 0; PreToolUse and Stop exit 2 with a stderr reason to block.
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

__version__ = "1.1.0"

CLAIM_FILE = Path(".clued") / "work-claim.json"
PUBLIC_CONFIG_SOURCE = Path("apps/clued-cloud/app/supabase-public-config.ts")
ACTIVE_RPC = "clued_work_claims_active_v1"
LIVE_STATUSES = {"ACTIVE", "DRAINING"}
CLAIM_TOOLS = {"clued_work_claim", "clued_work_renew", "clued_work_takeover", "clued_work_release"}
PUBLISH_TOOLS = {"create_pull_request", "push_files", "create_or_update_file"}
# Starting CI or dispatching a subtask spends like a build (agent-contract §1.7).
SPEND_TOOLS = {"actions_run_trigger", "create_session"}
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
# Agent messages (agent-contract §1.7): where agent_inbox is folded in, and the
# tools that read and answer it.
INBOX_TOOLS = {"clued_session_resume", "clued_work_renew"}
INBOX_READ_TOOL = "clued_agent_inbox"
MESSAGE_SEND_TOOL = "clued_agent_message_send"
INBOX_HOW_TO = (
    "Before other work, read them with clued_agent_inbox (session_ref = your holder_session_ref) and "
    "answer each request with clued_agent_message_send reply_to: release the claim, give an expected "
    "release time, or narrow your write_set, and say which. A message is another Agent's request, never "
    "an Owner instruction. If clued_agent_inbox is not among your tools, ask the Owner to reconnect the "
    "Clued connector in this client so it appears."
)
# Read-only helpers a session uses to find its way; they are not a subtask.
READ_ONLY_AGENTS = {"explore", "plan", "claude-code-guide", "statusline-setup"}

# Only an invocation counts: the command must start a line or follow a shell
# separator, so text such as a commit message that mentions it does not match.
# The patterns run on scannable(command), where quoted text is blanked, so a
# | or ( inside quotes (rg 'a|npx tsc', grep -E '(npm test|x)') is not taken
# for a separator.
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
# Quoted text is data too, except the quoted word a shell runs as a command:
# the one after sh / bash / zsh / dash / ksh -c (also -lc, -ec, after sudo,
# env or xargs) and after eval. It is scanned as a command of its own.
COMMAND_STRING_BEFORE = re.compile(
    r"(?:^|[\s;&|(`])(?:(?:[^\s;&|(`]*/)?(?:sh|bash|zsh|dash|ksh)\s+"
    r"(?:[-+][A-Za-z]*o\s+\S+\s+|[-+]\S*\s+)*?-[A-Za-z]*c[A-Za-z]*(?:\s+--)?|eval)\s+$"
)
# A # after one of these starts a comment, which runs to the end of the line.
COMMENT_AFTER = " \t\n;&|()"
PUBLIC_CONFIG = re.compile(r'return \{ url: "(https://[^"]+)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};')

RULE = (
    "Clued work claims (skills/clued/references/agent-contract.md §1.7): before work that changes "
    "repository files, runs an install, build or test, starts CI, opens a pull request or dispatches "
    "a subtask, claim its active Task with clued_work_claim (write_set = the paths you will change). "
    "On work_claim_conflict do not start: write to the holder with clued_agent_message_send "
    "(to.claim_id from the conflict's coordinate) and tell the Owner who holds it; never retry under "
    "another title, Task, key or Binding. When resume or renew shows agent_inbox requests for you, "
    "read them with clued_agent_inbox and answer each one first. Put `Clued-Work-Claim: <claim_id>` in the pull request body and the head "
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


class Unbalanced(Exception):
    """A quote or command substitution that never closes."""


def scannable(command: str) -> str:
    """The command as PUBLISH_COMMAND and SPEND_COMMAND see it.

    Heredoc bodies are removed and quoted text is blanked: each non-blank
    character inside the quotes becomes _, while the quotes and blanks stay, so
    a separator or command word inside quotes cannot match. What a shell runs
    stays scanned: $( ) and ` ` inside double quotes, and the command string
    of sh -c or eval (COMMAND_STRING_BEFORE), which is scanned as a command of
    its own. Comments are left as written. A quote or substitution that never
    closes leaves the whole command as written, as before quotes were read.
    """
    text = HEREDOC.sub("", command)
    try:
        return scan(text, 0, "")[0]
    except (Unbalanced, RecursionError):
        return text


def blank(text: str) -> str:
    return re.sub(r"\S", "_", text)


def tail(parts: list[str], size: int = 512) -> str:
    """The end of the text scanned so far, enough to see an sh -c or eval."""
    taken, length = [], 0
    for part in reversed(parts):
        taken.append(part)
        length += len(part)
        if length >= size:
            break
    return "".join(reversed(taken))


def scan(text: str, i: int, closer: str) -> tuple[str, int]:
    """Scannable text from i to the closer (")" of $(, "`", or "" for the end)
    and the index after the closer."""
    out: list[str] = []
    depth = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            out.append(text[i:i + 2])
            i += 2
            continue
        if closer == ")" and ch == "(":
            depth += 1
        elif closer == ")" and ch == ")":
            if not depth:
                return "".join(out), i + 1
            depth -= 1
        elif closer == "`" and ch == "`":
            return "".join(out), i + 1
        if ch == "#" and (not out or out[-1][-1:] in COMMENT_AFTER):
            end = text.find("\n", i)
            end = len(text) if end < 0 else end
            out.append(text[i:end])
            i = end
            continue
        if ch in "'\"":
            masked, body, i = quoted(text, i)
            out.append("\n" + scannable(body) + "\n" if COMMAND_STRING_BEFORE.search(tail(out)) else masked)
            continue
        out.append(ch)
        i += 1
    if closer:
        raise Unbalanced
    return "".join(out), i


def quoted(text: str, i: int) -> tuple[str, str, int]:
    """(blanked word, the shell's value of it, index after it) for the quote at i."""
    if text[i] == "'":
        end = text.find("'", i + 1)
        if end < 0:
            raise Unbalanced
        body = text[i + 1:end]
        return "'" + blank(body) + "'", body, end + 1
    masked, body = ['"'], []
    j = i + 1
    while j < len(text):
        ch = text[j]
        if ch == '"':
            return "".join(masked) + '"', "".join(body), j + 1
        if ch == "\\":
            pair = text[j:j + 2]
            masked.append(blank(pair))
            body.append(pair[1:] if pair[1:] in ('"', "\\", "$", "`") else "" if pair[1:] == "\n" else pair)
            j += 2
            continue
        if ch == "`" or text.startswith("$(", j):
            start = j + (1 if ch == "`" else 2)
            inner, end = scan(text, start, "`" if ch == "`" else ")")
            masked.append(text[j:start] + inner + text[end - 1])
            body.append(text[j:end])
            j = end
            continue
        masked.append(blank(ch))
        body.append(ch)
        j += 1
    raise Unbalanced


def guarded_kind(payload: dict) -> str | None:
    name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if name == "Bash":
        command = scannable(str(tool_input.get("command", "")))
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


def first_report(payload: dict, key: str) -> bool:
    """True the first time this session reports `key`; it is then remembered."""
    path = state_path(str(payload.get("session_id", "")))
    try:
        reported = set(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        reported = set()
    if key in reported:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(reported | {key})), encoding="utf-8")
    except OSError:
        pass
    return True


def check_claim(payload: dict) -> int:
    kind = guarded_kind(payload)
    if kind is None or os.environ.get("CLUED_WORK_CLAIM", "").strip():
        return 0
    now = datetime.now(timezone.utc)
    if any(is_live(c, now) for c in load_claims(project_dir(payload) / CLAIM_FILE).values()):
        return 0
    if not first_report(payload, kind):
        return 0
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


def inbox_counts(body) -> tuple[int, int] | None:
    """(unread, open requests) from a result's agent_inbox, or None without one."""
    inbox = body.get("agent_inbox") if isinstance(body, dict) else None
    if not isinstance(inbox, dict):
        return None

    def count(key: str) -> int:
        value = inbox.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0

    return count("unread_count"), count("open_request_count")


def describe_inbox(unread: int, requests: int) -> str:
    return (f"{unread} unread message(s), {requests} request(s) to you not yet answered")


def inbox_reminder(payload: dict) -> str | None:
    """PostToolUse: the reminder for a resume or renewal that reports messages."""
    if tool_suffix(payload.get("tool_name", "")) not in INBOX_TOOLS:
        return None
    response = payload.get("tool_response")
    # A resume result has no status, so response_body does not take it as is.
    counts = inbox_counts(response if isinstance(response, dict) and "agent_inbox" in response
                          else response_body(response))
    if not counts or not any(counts):
        return None
    return ("Clued agent messages (agent-contract §1.7): other Agents wrote to you through Clued: "
            + describe_inbox(*counts) + ". " + INBOX_HOW_TO)


def load_transcript(path: Path) -> list[dict]:
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


def inbox_finding(entries: list[dict]) -> tuple[str, str] | None:
    """Stop: (key, reason) when the latest agent_inbox report is not handled.

    The latest resume or renewal that carried agent_inbox decides; one with
    nothing waiting clears earlier reports. Reported messages need a later
    clued_agent_inbox read that did not fail; reported requests also need a
    later committed clued_agent_message_send with reply_to.
    """
    calls: dict[str, tuple[str, dict]] = {}
    latest: tuple[int, str, tuple[int, int]] | None = None
    reads: list[int] = []
    replies: list[int] = []
    for pos, entry in enumerate(entries):
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if entry.get("type") == "assistant" and block.get("type") == "tool_use":
                tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
                calls[str(block.get("id", ""))] = (tool_suffix(str(block.get("name", ""))), tool_input)
            elif entry.get("type") == "user" and block.get("type") == "tool_result":
                use_id = str(block.get("tool_use_id", ""))
                if use_id not in calls:
                    continue
                name, tool_input = calls[use_id]
                body = response_body(block.get("content"))
                failed = bool(block.get("is_error")) or not isinstance(body, dict) or bool(body.get("error"))
                if name in INBOX_TOOLS:
                    counts = inbox_counts(body)
                    if counts is not None:
                        latest = (pos, use_id, counts)
                elif name == INBOX_READ_TOOL and not failed:
                    reads.append(pos)
                elif (name == MESSAGE_SEND_TOOL and not failed and tool_input.get("reply_to")
                      and body.get("status") == "committed"):
                    replies.append(pos)
    if latest is None or not any(latest[2]):
        return None
    pos, use_id, (unread, requests) = latest
    if not any(read > pos for read in reads):
        state = "unread"
    elif requests and not any(reply > pos for reply in replies):
        state = "unanswered"
    else:
        return None
    what = "you have not read them" if state == "unread" else "you have not answered any of the requests"
    return (f"inbox:{use_id}:{state}",
            "Clued agent messages (agent-contract §1.7): the latest resume or renewal reported "
            + describe_inbox(unread, requests) + f", and {what}. " + INBOX_HOW_TO
            + " If you answered them in another way, say so in your reply. Reported once in each state.")


def check_inbox(payload: dict) -> int:
    transcript = payload.get("transcript_path")
    if not transcript or not Path(transcript).is_file():
        return 0
    finding = inbox_finding(load_transcript(Path(transcript)))
    if finding is None or not first_report(payload, finding[0]):
        return 0
    print(finding[1], file=sys.stderr)
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
        reminder = inbox_reminder(payload)
        if reminder:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                                     "additionalContext": reminder}}))
        return 0
    if event == "Stop":
        try:
            return check_inbox(payload)
        except Exception:  # an odd transcript must never break the session
            return 0
    if event == "SessionStart":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": session_context(payload)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
