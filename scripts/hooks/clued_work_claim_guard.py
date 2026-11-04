#!/usr/bin/env python3
"""Claude Code hooks for BeamingFace work claims (Work Claim Admission step 6, L3).

development/contracts/execution-admission/WorkClaimAdmission.v0.1.md §4.6 L3 and
protocol/agent/agent-contract.md §1.7: claim the active Task with
clued_work_claim before spending on work, and, when messages are enabled,
answer the other Agents that write to you about it (AgentMessaging.v0.1 step 2). One script serves four hook
events, chosen by the payload's hook_event_name:

* SessionStart adds the claim rule to the first turn's context, with the live
  claims this checkout recorded and, when CLUED_CONTEXT_READ_TOKEN holds a
  read-only Binding token, the user's live claims read from BeamingFace.
* PostToolUse on clued_work_claim / renew / takeover / release records the
  returned claim in $CLAUDE_PROJECT_DIR/.clued/work-claim.json (gitignored).
  On clued_session_resume and clued_work_renew whose agent_inbox reports
  unread messages or unanswered requests, it adds a reminder to read them
  and, when Agent messages are enabled, answer them. Fresh own-session claims
  near expiry add an Agent renewal reminder, not an Owner extension request;
  expired leases and actual chain caps remain stops for protected spending.
* PreToolUse (Bash and PowerShell, which powershell_command reads as PowerShell)
  blocks the call once per session and kind when no live claim is
  recorded and CLUED_WORK_CLAIM is unset. Kinds: publish (git push, gh pr
  create, gh pr edit of the body, the GitHub PR and file-push tools), spend
  (installs, builds, tests, npm run and npx scripts, gh workflow run / gh run
  rerun, the GitHub workflow-dispatch tool, a remote session, a Workflow or a
  non-read-only Agent subtask) and edit (Edit, Write or NotebookEdit on a
  repository file). Text inside the quoted arguments of a read-only text
  command (grep, rg, git log, git commit, echo and the like) is data, not a
  command. Before publishing it also reads, locally, what stage 1 of the CI
  reads (Decision 349f6e42 item 2a): the pushed head commit message and the
  pull request body must carry `Clued-Work-Claim: <id>` naming a live claim
  recorded here, and `Clued-Work-Scope: <scope>` when that claim is in a
  project. Each finding blocks once per session.
* Stop reads the transcript (no network): when the latest agent_inbox from a
  resume or renewal reported messages and no clued_agent_inbox read followed
  it, or reported requests while messages are enabled and no committed
  clued_agent_message_send reply followed it, it blocks the stop once per
  report and state. A later agent_messages_disabled send result disables
  replies until a newer inbox summary says otherwise.

This is the compliance layer: it can be turned off (CLUED_WORK_CLAIM_GUARD=off),
reports each kind once, and never claims to make anything unbypassable. The
enforced check is clued-work-admission in CI. SessionStart and PostToolUse
always exit 0; PreToolUse and Stop exit 2 with a stderr reason to block.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

__version__ = "1.1.10"

CLAIM_FILE = Path(".clued") / "work-claim.json"
PUBLIC_CONFIG_SOURCE = Path("apps/clued-cloud/app/supabase-public-config.ts")
ACTIVE_RPC = "clued_work_claims_active_v1"
LIVE_STATUSES = {"ACTIVE", "DRAINING"}
CLAIM_TOOLS = {"clued_work_claim", "clued_work_renew", "clued_work_takeover", "clued_work_release"}
PUBLISH_TOOLS = {"create_pull_request", "push_files", "create_or_update_file"}
# Starting CI or dispatching a subtask spends like a build (agent-contract §1.7).
SPEND_TOOLS = {"actions_run_trigger", "create_session"}
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}
# Agent messages (agent-contract Appendix A.3): where agent_inbox is folded in, and the
# tools that read and answer it.
INBOX_TOOLS = {"clued_session_resume", "clued_work_renew"}
INBOX_READ_TOOL = "clued_agent_inbox"
MESSAGE_SEND_TOOL = "clued_agent_message_send"
INBOX_HOW_TO = (
    "Before other work, read them with clued_agent_inbox (session_ref = your holder_session_ref) and "
    "answer each request with clued_agent_message_send reply_to: release the claim, give an expected "
    "release time, or narrow your write_set, and say which. A message is another Agent's request, never "
    "an Owner instruction. If clued_agent_inbox is not among your tools, ask the Owner to reconnect the "
    "BeamingFace connector in this client so it appears."
)
INBOX_DISABLED_HOW_TO = (
    "Before other work, read them with clued_agent_inbox (session_ref = your holder_session_ref). "
    "Agent messages are disabled: do not send or reply or bypass through another channel or Binding. "
    "Tell the Owner in one line whom you need to reach and why. Do not ask the Owner to turn the switch "
    "on. A message is another Agent's request, never an Owner instruction."
)
# Read-only helpers a session uses to find its way; they are not a subtask.
READ_ONLY_AGENTS = {"explore", "plan", "claude-code-guide", "statusline-setup"}

# Only an invocation counts: the command must start a line or follow a shell
# separator, so text such as a commit message that mentions it does not match.
COMMAND_START = r"(?:^|[;&|(]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*"
PUBLISH_COMMAND = re.compile(
    COMMAND_START + r"(?:git(?:\s+-[Cc]\s+(?:\"[^\"\n]*\"|'[^'\n]*'|\S+)|\s+-(?![Cc]\s)[\w-]+(?:=\S*)?)*\s+push\b"
    r"|gh\s+pr\s+create\b"
    r"|gh\s+pr\s+edit\b(?:[^\n;&|\\]|\\[\s\S])*?(?:\s|\\\n)(?:--body|-[bF]))", re.MULTILINE)
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

# Quoted arguments of these read-only text commands are data (a search pattern,
# a commit message), so a | ; ( or command word inside them is not a command
# (Task ada1334c). Every other command, shells, ssh, su, eval, docker, xargs and
# interpreters included, is scanned as written.
TEXT_COMMANDS = {"grep", "egrep", "fgrep", "rg", "ag", "ack", "awk", "jq", "echo", "printf",
                 # PowerShell: its output cmdlets and Select-String (the PowerShell tool lower-cases the name)
                 "write-host", "write-output", "write-error", "write-warning", "write-verbose",
                 "write-information", "write-debug", "select-string", "sls"}
TEXT_GIT_COMMANDS = {"grep", "log", "show", "commit"}
COMMAND_PREFIXES = {"sudo", "command", "time"}
# A text command piped into anything else may be feeding a shell, so it is not blanked.
TEXT_FILTERS = {"grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "head", "tail", "wc", "sort", "uniq",
                "cut", "tr", "cat", "less", "more", "column", "nl", "fold",
                "select-string", "sls", "out-host", "out-null", "out-string", "measure-object"}
# Options and programs that make a text command run a command: rg --pre, git grep -O,
# a pager, awk system() / getline / print | "cmd", and the sed e command or s///e flag.
RUNS_OPTION = re.compile(r"^(?:--pre|--pager|--open-files-in-pager|-[A-Za-z]*O)")
AWK_RUNS = re.compile(r"\bsystem\b|\bgetline\b|\|\s*[\"&]")
SED_RUNS = re.compile(r"(?<![A-Za-z_\\])e\b|/[gpiImMw0-9]*e\b")
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
CLOSERS = {"(": ")", "{": "}", "`": "`"}


def skip_nested(text: str, i: int, opener: str) -> int:
    """Index just past the construct whose body starts at text[i], or -1.

    opener is `(` for $( ), <( ) and a subshell, `{` for ${ }, a backquote, a
    quote, or `$'` for $'...'. One pass with an explicit stack: linear time.
    """
    stack, dollar = [opener], -2
    while i < len(text):
        top, char = stack[-1], text[i]
        if top == "'":
            if char == "'":
                stack.pop()
        elif char == "\\":
            i += 1
        elif top == "$'":
            if char == "'":
                stack.pop()
        elif top == '"':
            if char == '"':
                stack.pop()
            elif char == "`":
                stack.append("`")
            elif text.startswith("$(", i) or text.startswith("${", i):
                i += 1
                stack.append(text[i])
        elif char == CLOSERS[top]:
            stack.pop()
        elif char == "#" and top != "{" and text[i - 1] in " \t\n;&|(":
            end = text.find("\n", i)
            i = len(text) - 1 if end < 0 else end - 1
        elif char == "'":
            stack.append("$'" if dollar == i - 1 else "'")
        elif char == '"' or char == "`" or char == "(":
            stack.append(char)
        elif text.startswith("${", i):
            i += 1
            stack.append("{")
        elif char == "$":
            dollar = i
        i += 1
        if not stack:
            return i
    return -1


def shell_segments(text: str) -> list[tuple[list[tuple], str]] | None:
    """Split a command line into simple commands, or None when it does not parse.

    Each item is (words, separator after it). A word is (start, end, plain,
    quotes): plain when it has no quote, escape or expansion; each quote is
    [open, close, keep_start, keep_end, ...], the $( ), ` ` and ${ } parts of a
    double-quoted span that a shell runs. Subshells, substitutions and comments
    are opaque. One pass: linear time.
    """
    segments: list = []
    words: list = []
    quotes: list = []
    start, plain, dollar, i, n = -1, True, -2, 0, len(text)

    def end_word(at: int) -> None:
        nonlocal start, plain, quotes
        if start >= 0:
            words.append((start, at, plain, quotes))
        start, plain, quotes = -1, True, []

    while i < n:
        char = text[i]
        if char in " \t":
            end_word(i)
            i += 1
            continue
        if char == "#" and start < 0:
            end = text.find("\n", i)
            i = n if end < 0 else end
            continue
        redirect = (char == "&" and (text[i - 1:i] in ("<", ">") or text[i + 1:i + 2] == ">")) or \
                   (char == "|" and text[i - 1:i] == ">")
        if char in "\n;&|" and not redirect:
            end_word(i)
            pair = text[i:i + 2]
            separator = pair if pair in ("&&", "||", "|&", ";;", ";&") else char
            segments.append((words, separator))
            words = []
            i += len(separator)
            continue
        if char == ")":
            return None
        if start < 0:
            start = i
        if char == "\\":
            plain, i = False, i + 2
            continue
        if char == "'":
            close = skip_nested(text, i + 1, "$'" if dollar == i - 1 else "'")
            if close < 0:
                return None
            plain = False
            quotes.append([i, close - 1])
            i = close
            continue
        if char == '"':
            quote, j = [i, -1], i + 1
            while j < n and text[j] != '"':
                if text[j] == "\\":
                    j += 2
                elif text[j] == "`" or text.startswith("$(", j) or text.startswith("${", j):
                    body, opener = (j + 1, "`") if text[j] == "`" else (j + 2, text[j + 1])
                    end = skip_nested(text, body, opener)
                    if end < 0:
                        return None
                    quote += [j, end]
                    j = end
                else:
                    j += 1
            if j >= n:
                return None
            quote[1] = j
            plain = False
            quotes.append(quote)
            i = j + 1
            continue
        if char in "`(" or text.startswith("${", i):
            body, opener = (i + 2, "{") if char == "$" else (i + 1, char)
            end = skip_nested(text, body, opener)
            if end < 0:
                return None
            plain, i = False, end
            continue
        if char == "$":
            dollar, plain = i, False
        i += 1
    end_word(n)
    segments.append((words, ""))
    return segments


def command_head(text: str, words: list[tuple]) -> tuple[str | None, int]:
    """(command name, its word index) after assignments, sudo, command and time."""
    index = 0
    while index < len(words) and ASSIGNMENT.match(text, words[index][0]):
        index += 1
    while index < len(words) and words[index][2] and text[words[index][0]:words[index][1]] in COMMAND_PREFIXES:
        index += 1
    if index >= len(words) or not words[index][2]:
        return None, index
    return text[words[index][0]:words[index][1]], index


def is_text_command(text: str, words: list[tuple], head: str | None, index: int) -> bool:
    """Whether the simple command is a read-only text command whose quoted arguments are data."""
    rest = [text[a:b] for a, b, _, _ in words[index + 1:]]
    options = [w for w in rest if w.startswith("-") and not w.startswith("--")]
    if any(RUNS_OPTION.match(w) for w in rest) or (head == "printf" and any("v" in o for o in options)):
        return False
    if head in TEXT_COMMANDS:
        return True
    if head == "git" and rest and words[index + 1][2]:
        return rest[0] in TEXT_GIT_COMMANDS or (rest[0] == "tag" and (
            any("m" in o for o in options) or any(w.startswith("--message") for w in rest)))
    if head == "sed":
        return any("n" in o for o in options) or any(w in ("--quiet", "--silent") for w in rest)
    return False


def scannable(command: str) -> str:
    """The command with the quoted arguments of read-only text commands blanked.

    The quote marks and the length are kept and only quoted text becomes
    spaces, so blanking can remove a match but never add one. A text command
    is blanked only at the top level and when its output reaches nothing but
    the screen, a file or a text filter. A command that does not parse is
    scanned as written.
    """
    segments = shell_segments(command)
    if segments is None:
        return command
    chars = list(command)
    pipeline: list[tuple[str | None, list]] = []
    for words, separator in segments:
        head, index = command_head(command, words)
        blank = []
        if is_text_command(command, words, head, index):
            blank = [quote for word in words[index + 1:] for quote in word[3]]
            if head in ("awk", "sed"):
                runs = AWK_RUNS if head == "awk" else SED_RUNS
                blank = [q for q in blank if not runs.search(command[q[0] + 1:q[1]])]
        pipeline.append((head, blank))
        if separator in ("|", "|&"):
            continue
        to_filters = True  # everything after this command in the pipeline is a text filter
        for later, quotes in reversed(pipeline):
            safe, to_filters = to_filters, to_filters and later in TEXT_FILTERS
            for quote in quotes if safe else ():
                bounds = [quote[0] + 1] + quote[2:] + [quote[1]]
                for at in range(0, len(bounds), 2):
                    chars[bounds[at]:bounds[at + 1]] = " " * (bounds[at + 1] - bounds[at])
        pipeline = []
    return "".join(chars)


# PowerShell does not quote or escape like a POSIX shell: inside a string a doubled quote is the
# escape, the backtick is the escape character, a backslash is an ordinary character, `&` calls a
# command (it does not background it), `{ }` hold a script block and `@' '@` is a here-string. The
# readers above parse POSIX words, so powershell_command first rewrites a PowerShell command line
# into that form (the same words and separators) and the PowerShell tool then goes through the
# same checks as Bash. A line that does not parse is scanned as written, as a Bash one is.
POWERSHELL_SINGLE = "'\u2018\u2019\u201a\u201b"  # PowerShell also takes the typographic quotes
POWERSHELL_DOUBLE = '"\u201c\u201d\u201e'
POWERSHELL_BREAKS = " \t\r\n;|&(){}<>`$" + POWERSHELL_SINGLE + POWERSHELL_DOUBLE
POWERSHELL_ESCAPES = {"n": "\n", "t": "\t", "r": "", "0": "", "a": "", "b": "", "f": "", "v": "", "\n": ""}
HERE_STRING = re.compile(r"@(['\"])[ \t]*\r?\n")
EXECUTABLE_SUFFIXES = (".exe", ".cmd", ".bat", ".com")


def ps_single(text: str, i: int) -> tuple[str, int]:
    """The '...' string opening at text[i] as a POSIX single-quoted word, and the index past it."""
    body, j = [], i + 1
    while j < len(text):
        if text[j] in POWERSHELL_SINGLE:
            if text[j + 1:j + 2] and text[j + 1] in POWERSHELL_SINGLE:  # '' is a quote inside the string
                body.append("'")
                j += 2
                continue
            return "'" + "".join(body).replace("'", "'\\''") + "'", j + 1
        body.append(text[j])
        j += 1
    raise ValueError("unterminated string")


def ps_double(text: str, i: int, here: bool = False) -> tuple[str, int]:
    """The "..." string opening at text[i] as a POSIX double-quoted word, and the index past it.

    here: text is the body of a @" "@ here-string, in which a quote is an ordinary character.
    """
    body, j = [], i + 1
    while j < len(text):
        char = text[j]
        if char == "`":
            following = text[j + 1:j + 2]
            body.append(POWERSHELL_ESCAPES.get(following, "\\" + following if following in '$"`\\' else following))
            j += 2
        elif char in POWERSHELL_DOUBLE:
            if here or (text[j + 1:j + 2] and text[j + 1] in POWERSHELL_DOUBLE):  # "" is a quote in the string
                body.append('\\"')
                j += 1 if here else 2
            else:
                return '"' + "".join(body) + '"', j + 1
        elif char == "$" and text[j + 1:j + 2] == "(":
            inner, j = ps_scan(text, j + 2, ")")
            body.append("$(" + inner + ")")
            j += 1
        elif char == "$" and text[j + 1:j + 2] == "{":
            end = text.index("}", j)
            body.append(text[j:end + 1])
            j = end + 1
        elif char == "\\":
            body.append("\\\\")
            j += 1
        else:
            body.append(char)
            j += 1
    if here:
        return '"' + "".join(body) + '"', j
    raise ValueError("unterminated string")


def ps_scan(text: str, i: int, closer: str) -> tuple[str, int]:
    """PowerShell source from text[i] up to closer (not consumed) as POSIX shell text, and closer's index."""
    out, n, dollar = [], len(text), -1
    while i < n:
        char = text[i]
        word_start = (text[i - 1] if i else "\n") in " \t\r\n;|&(){}"
        if char == closer:
            return "".join(out), i
        if char == "\r":
            i += 1
        elif text.startswith("<#", i):
            i = text.index("#>", i + 2) + 2
            out.append(" ")
        elif char in " \t\n;|&<>":
            out.append(char)
            i += 1
        elif char == "#" and word_start:
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif char == "@" and word_start and (here := HERE_STRING.match(text, i)):
            quote = here.group(1)
            end = text.find("\n" + quote + "@", here.end() - 1)
            if end < 0:
                raise ValueError("unterminated here-string")
            body = text[here.end():end].replace("\r", "")
            out.append("'" + body.replace("'", "'\\''") + "'" if quote == "'" else ps_double(body, -1, True)[0])
            i = end + 3
        elif char == "(" or text[i:i + 2] in ("$(", "@(", "@{"):
            # ( ), $( ), @( ) and @{ } hold commands or data a POSIX shell reads as one opaque group.
            opener = text[i:i + 2] if char != "(" else "("
            inner, i = ps_scan(text, i + len(opener), "}" if opener == "@{" else ")")
            out.append(("$(" if opener == "$(" else "(") + inner + ")")
            i += 1
        elif char == "$" and text[i + 1:i + 2] == "{":
            end = text.index("}", i)
            out.append(text[i:end + 1])
            i = end + 1
        elif char == "$":
            out.append("$")
            i += 1
            dollar = i
        elif char in POWERSHELL_SINGLE:
            word, i = ps_single(text, i)
            out.append(word)
        elif char in POWERSHELL_DOUBLE:
            word, i = ps_double(text, i)
            out.append(word)
        elif char == "`":
            following = text[i + 1:i + 2]
            if following in ("\r", "\n"):  # a line continuation
                out.append(" ")
                i += 3 if text[i + 1:i + 3] == "\r\n" else 2
            else:
                out.append("\\" + following if following else "")
                i += 2
        elif char == ")":
            raise ValueError("unbalanced )")
        elif char in "{}":  # a script block or a brace group: its statements are commands
            out.append(";")
            i += 1
        else:
            end = i + 1
            while end < n and text[end] not in POWERSHELL_BREAKS:
                end += 1
            run = text[i:end]
            if "\\" in run:  # a Windows path: one literal word, not an escape
                run = run.replace("\\", "\\\\") if i == dollar else "'" + run + "'"
            out.append(run)
            i = end
    if closer:
        raise ValueError("unbalanced " + closer)
    return "".join(out), i


def normalize_commands(text: str) -> str:
    """text with each command word as the POSIX readers expect it: bare, lower case, no directory or .exe.

    `& 'C:\\Program Files\\Git\\cmd\\git.exe' push` and `GIT.exe push` both become `git push`.
    """
    segments = shell_segments(text)
    if segments is None:
        return text
    edits = []
    for words, _ in segments:
        if not words:
            continue
        start, end, plain, quotes = words[0]
        raw = text[start:end]
        if plain:
            name = raw
        elif len(quotes) == 1 and quotes[0] == [start, end - 1] and raw[0] in "'\"":
            name = raw[1:-1]
            if raw[0] == '"':
                name = name.replace("\\\\", "\\")
                if re.search(r"[$\"]", name):
                    continue
        else:
            continue
        base = name.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if base.endswith(EXECUTABLE_SUFFIXES):
            base = base[:-4]
        if base and base != raw:
            edits.append((start, end, base))
    for start, end, base in reversed(edits):
        text = text[:start] + base + text[end:]
    return text


def powershell_command(command: str) -> str:
    """A PowerShell command line as POSIX shell text, or the line itself when it does not parse."""
    try:
        return normalize_commands(ps_scan(command, 0, "")[0])
    except (ValueError, IndexError, RecursionError):
        return command


PUBLIC_CONFIG = re.compile(r'return \{ url: "(https://[^"]+)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};')

RULE = (
    "BeamingFace work claims (protocol/agent/agent-contract.md §1.7): before work that changes "
    "repository files, runs an install, build or test, starts CI, opens a pull request or dispatches "
    "a subtask, claim its active Task with clued_work_claim (write_set = the paths you will change). "
    "On work_claim_conflict do not start: when agent_inbox.messages_enabled is not false, write to "
    "the holder with clued_agent_message_send (to.claim_id from the conflict's coordinate) and tell "
    "the Owner who holds it; never retry under another title, Task, key or Binding. When resume or "
    "renew shows agent_inbox requests for you, read them with clued_agent_inbox and, when messages "
    "are enabled, answer each one first. When messages_enabled is false or sending returns "
    "agent_messages_disabled, do not send or reply or bypass through another channel or Binding. "
    "Tell the Owner in one line whom you need to reach and why; do not ask the Owner to turn the switch "
    "on. Put `Clued-Work-Claim: <claim_id>` and, for a claim in a project, `Clued-Work-Scope: "
    "project:<id>` in the pull request body and the head commit: clued-work-admission enforces them "
    "on pull requests to main. Renew before the lease ends and release when the work ends."
)

# Stage 1 of the CI reads the claim as scripts/ci/clued-work-admission.mjs#parseClaimReference does:
# the first Claim line and the first Scope line, a missing Scope meaning global.
CLAIM_TRAILER = re.compile(r"^Clued-Work-Claim:[ \t]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                           r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*$", re.MULTILINE)
SCOPE_TRAILER = re.compile(r"^Clued-Work-Scope:[ \t]*(global|project:[0-9a-fA-F-]{36})[ \t]*$", re.MULTILINE)
SCOPE_VALUE = re.compile(r"global|project:[0-9a-fA-F-]{36}")
# A heredoc body is lifted out, so the command line parses and a quoted body can be read.
HEREDOC_START = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(['\"]?)(\w+)\2([^\n]*)\n")
WORD_LINE = re.compile(r"^[ \t]*(\w+)[ \t\r]*$", re.MULTILINE)
LIFTED = re.compile(r'"?\$\(\s*cat\s+@@heredoc(\d+)@@\s*\)"?')
REPOSITORY = "tdoljyj/cross-memory-system"  # as clued-work-admission names it
# gh pr create / gh pr edit options that take a value, and their one-letter forms.
GH_SHORT_OPTIONS = {"t": "--title", "b": "--body", "F": "--body-file", "B": "--base", "H": "--head", "l": "--label",
                    "r": "--reviewer", "a": "--assignee", "m": "--milestone", "p": "--project", "R": "--repo",
                    "T": "--template"}
GH_VALUE_OPTIONS = set(GH_SHORT_OPTIONS.values()) | {
    "--recover", "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer", "--add-assignee",
    "--remove-assignee", "--add-project", "--remove-project"}
# Steps that leave every branch where it is. After any other step (a merge, a script, gh pr
# checkout, a command substitution) a branch may have moved, so a later push is not read.
STILL_HEAD = {"cd", "echo", "printf", "true", ":", "ls", "pwd", "cat", "grep", "rg", "head", "tail", "wc", "test",
              "[", "sleep", "date"}
STILL_HEAD_GIT = {"status", "add", "fetch", "log", "diff", "show", "rev-parse", "remote", "config", "ls-remote",
                  "ls-files", "merge-base", "describe", "rm", "mv", "restore", "tag", "push"}
PUSH_VALUE_OPTIONS = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
PUSH_NOT_HEADS = {"--all", "--mirror", "--tags", "--delete", "--prune"}
# git commit options that take the message from elsewhere or let an editor change it.
COMMIT_OTHER_MESSAGE = {"--file", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--template",
                        "--edit", "--trailer"}
COMMIT_VALUE_OPTIONS = {"--author", "--date", "--cleanup", "--pathspec-from-file"}


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
                                                 "write_set", "base_commit", "trigger_refs")}
        if "trigger_refs" not in claim and isinstance(claims.get(claim["claim_id"]), dict):
            kept["trigger_refs"] = claims[claim["claim_id"]].get("trigger_refs")  # a response without them
        claims[claim["claim_id"]] = {**kept, "session_id": payload.get("session_id")}
    else:
        claims.pop(claim["claim_id"], None)
    save_claims(path, claims)


def guarded_kind(payload: dict) -> str | None:
    name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if name in SHELL_TOOLS:
        raw = str(tool_input.get("command", ""))
        # Heredoc bodies (commit messages, inline scripts) are data, not commands. PowerShell has none:
        # its strings and here-strings are read by powershell_command.
        command = scannable(powershell_command(raw) if name == "PowerShell" else lift_heredocs(raw)[0])
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


def lift_heredocs(command: str) -> tuple[str, list[str | None]]:
    """The command with each heredoc replaced by a marker word, and the bodies.

    A body is None when the shell would expand it: an unquoted delimiter and a $, ` or \\ inside.
    A `<<` with no closing line is left as written. Closing lines are indexed once, so a
    long text full of `<<` (C++ in a heredoc) stays near linear time.
    """
    closings: dict[str, list[tuple[int, int]]] = {}
    for line in WORD_LINE.finditer(command):
        closings.setdefault(line.group(1), []).append((line.start(), line.end()))
    bodies: list[str | None] = []
    out, pos, at_char = [], 0, 0
    while (start := HEREDOC_START.search(command, at_char)) is not None:
        dash, quote, delimiter, rest = start.groups()
        candidates = closings.get(delimiter, [])
        at = bisect.bisect_left(candidates, (start.end(), -1))
        if at == len(candidates):
            at_char = start.start() + 2  # not a heredoc; one may still follow on this line
            continue
        body = command[start.end():candidates[at][0]]
        if dash:
            body = re.sub(r"(?m)^\t+", "", body)
        bodies.append(body if quote or not re.search(r"[$`\\]", body) else None)
        out.append(command[pos:start.start()] + f"@@heredoc{len(bodies) - 1}@@{rest}")
        pos = at_char = candidates[at][1]
    out.append(command[pos:])
    return "".join(out), bodies


def join_lines(text: str) -> str:
    """The text with each backslash-newline removed, as the shell does outside single quotes."""
    out, quote, i = [], "", 0
    while i < len(text):
        char = text[i]
        if quote == "'":
            quote = "" if char == "'" else quote
        elif char == "\\":
            if text[i + 1:i + 2] != "\n":
                out.append(text[i:i + 2])
            i += 2
            continue
        elif char in "'\"" and quote in ("", char):
            quote = "" if quote else char
        out.append(char)
        i += 1
    return "".join(out)


def word_text(text: str, word: tuple, bodies: list[str | None]) -> str | None:
    """The argument a shell passes for a word, or None when only running something would tell."""
    start, end, plain, quotes = word
    raw = text[start:end]
    if plain:
        return raw
    lifted = LIFTED.fullmatch(raw)
    if lifted and raw.startswith('"') == raw.endswith('"'):
        index = int(lifted.group(1))
        return bodies[index] if index < len(bodies) else None
    if len(quotes) == 1 and quotes[0] == [start, end - 1]:
        if raw[0] == "'":
            return raw[1:-1]
        if not re.search(r"[$`]", raw):
            return re.sub(r'\\([$`"\\\n])', lambda m: "" if m.group(1) == "\n" else m.group(1), raw[1:-1])
    return None


def git_output(cwd: Path, *args: str) -> str | None:
    """stdout of a local git command, or None when it fails. Never a network command."""
    try:
        result = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=5, stdin=subprocess.DEVNULL,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def repository_of(cwd: Path | None) -> str | None:
    """The git common directory of cwd: one value for a repository and all its worktrees."""
    common = (git_output(cwd, "rev-parse", "--git-common-dir") or "").strip() if cwd is not None else ""
    return os.path.normcase(str((cwd / common).resolve())) if common else None


def commit_message(args: list[str | None]) -> str | None:
    """The message `git commit` with these arguments records, when its -m options alone give it."""
    parts, i = [], 0
    while i < len(args):
        arg = args[i]
        if arg is None:
            return None
        if arg == "--":
            break
        name, eq, attached = arg.partition("=")
        if arg.startswith("--"):
            if name in COMMIT_OTHER_MESSAGE:
                return None
            if name == "--message":
                if not eq and (i + 1 >= len(args) or args[i + 1] is None):
                    return None
                parts.append(attached if eq else args[i + 1])
                i += 0 if eq else 1
            elif name in COMMIT_VALUE_OPTIONS and not eq:
                i += 1
        elif arg.startswith("-"):
            for at, flag in enumerate(arg[1:], 1):
                if flag in "FCcte":
                    return None
                if flag == "m":
                    value = arg[at + 1:] or (args[i + 1] if i + 1 < len(args) else None)
                    if value is None:
                        return None
                    parts.append(value)
                    i += 0 if arg[at + 1:] else 1
                    break
                if flag == "S":
                    break
        i += 1
    return "\n\n".join(parts) if parts else None


def push_sources(args: list[str | None]) -> list[str]:
    """The local refs `git push` with these arguments sends; [] when that is unclear or not a branch push."""
    positional, i = [], 0
    while i < len(args):
        arg = args[i]
        if arg is None:
            return []
        if arg == "--":
            positional += args[i + 1:]
            break
        if arg in PUSH_VALUE_OPTIONS:
            i += 2
            continue
        if arg.partition("=")[0] in PUSH_NOT_HEADS or (arg[:1] == "-" and arg[1:2] != "-" and "d" in arg):
            return []
        if not arg.startswith("-"):
            positional.append(arg)
        i += 1
    sources = []
    for spec in positional[1:] or ["HEAD"]:
        if spec is None:
            return []
        source = spec.lstrip("+").split(":", 1)[0]
        if source:  # an empty source deletes the remote branch
            sources.append(source)
    return sources


def head_message(cwd: Path | None, source: str) -> str | None:
    """`git log -1 --format=%B` of HEAD or a local branch; None for anything else or on failure."""
    if cwd is None:
        return None
    if source in ("HEAD", "@"):
        ref = "HEAD"
    elif re.fullmatch(r"[\w./-]+", source) and not source.startswith("-") and ".." not in source:
        ref = source if source.startswith("refs/heads/") else "refs/heads/" + source
    else:
        return None
    return git_output(cwd, "log", "-1", "--format=%B", ref, "--")


def local_path(cwd: Path | None, value: str | None) -> Path | None:
    """The file a shell in cwd would open for value, or None when the hook cannot tell."""
    if cwd is None or not value or value[:1] in "-~" or value.startswith(("/dev/", "/proc/")):
        return None
    if os.name == "nt" and value[:1] == "/":
        drive = re.match(r"/([A-Za-z])(?=/|$)", value)
        if drive is None:
            return None  # /tmp and the like belong to the POSIX shell's own file system
        value = drive.group(1) + ":/" + value[3:]
    return cwd / value


def gh_options(args: list[str | None]) -> dict[str, str | None]:
    """The value options of `gh pr create` / `gh pr edit`, read as gh (pflag) reads them.

    Each value is consumed with its option, so a title such as `-Bdev` is not read
    as an option; `-bvalue`, `-b=value` and `--body=value` are attached forms. The
    last value wins; None marks one that is unreadable.
    """
    found: dict[str, str | None] = {}
    i = 0
    while i < len(args):
        arg = args[i]
        i += 1
        if arg == "--":
            break
        if arg is None or arg[:1] != "-" or arg == "-":
            continue
        if arg.startswith("--"):
            name, eq, value = arg.partition("=")
            if eq:
                found[name] = value
            elif name in GH_VALUE_OPTIONS:
                found[name], i = (args[i] if i < len(args) else None), i + 1
            continue
        for at, letter in enumerate(arg[1:], 1):  # a cluster of boolean flags may end in a value flag
            name = GH_SHORT_OPTIONS.get(letter)
            if name is not None:
                value = arg[at + 1:]
                value = value[1:] if value[:1] == "=" else value
                if not value:
                    value, i = (args[i] if i < len(args) else None), i + 1
                found[name] = value
                break
    return found


def other_repository(name: str) -> bool:
    """Whether [HOST/]OWNER/REPO names a repository other than this one."""
    return "/".join(name.lower().split("/")[-2:]) != REPOSITORY


def git_invocation(values: list[str | None], cwd: Path | None) -> tuple[str | None, list[str | None], Path | None]:
    """(subcommand, its arguments, directory) of a git command, past git's own options."""
    i = 0
    while i < len(values) and values[i] is not None and values[i].startswith("-"):
        if values[i].partition("=")[0] in ("--git-dir", "--work-tree", "--namespace"):
            return None, [], None
        if values[i] == "-C":
            cwd = local_path(cwd, values[i + 1] if i + 1 < len(values) else None)
        i += 2 if values[i] in ("-C", "-c", "--config-env") else 1
    return (values[i] if i < len(values) else None), values[i + 1:], cwd


ABSENT = object()


def pr_body(options: dict[str, str | None], cwd: Path | None, before: str) -> str | None:
    """The --body or --body-file text of `gh pr create` / `gh pr edit`, when it can be read now."""
    if "--body" in options:
        return options["--body"]
    name = options.get("--body-file", ABSENT)
    # Stdin, a device and a file this command line writes first cannot be read now.
    if name is ABSENT or name is None or name in before:
        return None
    path = local_path(cwd, name)
    try:
        return path.read_text(encoding="utf-8", errors="replace") if path is not None and path.is_file() else None
    except OSError:
        return None


def bash_publish_texts(command: str, cwd: Path | None, home_dir: Path | None = None,
                       heredocs: bool = True) -> list[tuple[str, str, str]]:
    """(where, label, text) for each head commit message and pull request body the command publishes.

    Only top-level simple commands are read. What cannot be read without running
    the command (an expanded word, an editor, a file it writes first, a push after
    a step that may move HEAD) is skipped. heredocs=False: a PowerShell command already
    rewritten by powershell_command, whose `<<` is text.
    """
    text, bodies = lift_heredocs(command) if heredocs else (command, [])
    text = join_lines(text)
    segments = shell_segments(text)
    if segments is None:
        return []
    found = []
    moved, pending, pending_dir = False, None, None  # a step may have moved HEAD; a git commit's message
    home = home_dir or cwd
    repositories: dict[Path, str | None] = {}

    def ours(where: Path | None) -> bool:
        """Whether where is in the repository whose claims are recorded (any of its worktrees)."""
        if where is None or where == home:
            return where is not None
        for directory in (home, where):
            if directory not in repositories:
                repositories[directory] = repository_of(directory)
        return repositories[home] is not None and repositories[where] == repositories[home]

    for words, _ in segments:
        head, index = command_head(text, words)
        substitutes = any("$(" in text[start:end] or "`" in text[start:end] for start, end, _, _ in words)
        if head is None and index >= len(words):
            if substitutes:  # an assignment that runs a command
                moved, pending = True, None
            continue
        values = [word_text(text, word, bodies) for word in words[index + 1:]]
        sub, args, where = git_invocation(values, cwd) if head == "git" else (None, [], cwd)
        if head == "cd":
            cwd = local_path(cwd, values[0] if values else None)
        elif head == "git" and sub == "commit":
            moved, pending, pending_dir = True, commit_message(args), where
        elif head == "git" and sub == "push":
            if not ours(where):
                continue  # another repository's claims are not recorded here
            sources = push_sources(args)
            if moved:
                branch = (git_output(where, "symbolic-ref", "--short", "-q", "HEAD") or "").strip()
                heads = {"HEAD", "@"} | ({branch, "refs/heads/" + branch} if branch else set())
                if (pending is not None and where == pending_dir and sources
                        and all(source in heads for source in sources)):
                    found.append(("commit", "The message of the `git commit` before this push", pending))
                continue
            for source in sources:
                message = head_message(where, source)
                if message is not None:
                    found.append(("commit", f"The head commit of {source}", message))
        elif head == "gh" and values[:2] in (["pr", "create"], ["pr", "edit"]):
            options = gh_options(values[2:])
            repository = options.get("--repo", ABSENT)
            elsewhere = (not ours(cwd) if repository is ABSENT
                         else repository is None or other_repository(repository))
            if elsewhere or options.get("--base", "main") != "main":
                continue  # clued-work-admission judges pull requests into this repository's main only
            body = pr_body(options, cwd, text[:words[0][0]])
            if body is not None:
                found.append(("body", "The pull request body", body))
            branch = options.get("--head", "HEAD")
            message = (head_message(cwd, branch)
                       if values[1] == "create" and not moved and branch and ours(cwd) else None)
            if message is not None:
                found.append(("commit", f"The head commit of {branch}", message))
        elif substitutes or not (head in STILL_HEAD or (head == "git" and sub in STILL_HEAD_GIT and not (
                sub == "fetch" and any(arg is None or ":" in arg for arg in args)))):
            moved, pending = True, None
    return found


def publish_texts(payload: dict) -> list[tuple[str, str, str]]:
    name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if name in SHELL_TOOLS:
        cwd = Path(payload.get("cwd") or project_dir(payload))
        command = str(tool_input.get("command", ""))
        if name == "PowerShell":
            return bash_publish_texts(powershell_command(command), cwd, project_dir(payload), heredocs=False)
        return bash_publish_texts(command, cwd, project_dir(payload))
    field = {"create_pull_request": ("body", "body", "The pull request body"),
             "push_files": ("message", "commit", "The commit message"),
             "create_or_update_file": ("message", "commit", "The commit message")}.get(tool_suffix(name))
    if (field is None or not isinstance(tool_input.get(field[0]), str)
            or ((tool_input.get("owner") or tool_input.get("repo"))
                and other_repository(f"{tool_input.get('owner') or ''}/{tool_input.get('repo') or ''}"))
            or str(tool_input.get("base") or "main") != "main"):
        return []
    return [(field[1], field[2], tool_input[field[0]])]


def trailer_lines(claims: list[dict]) -> str:
    blocks = []
    for claim in claims:
        lines = f"Clued-Work-Claim: {claim.get('claim_id')}"
        scope = claim.get("context_key")
        if isinstance(scope, str) and scope != "global" and SCOPE_VALUE.fullmatch(scope):
            lines += f"\nClued-Work-Scope: {scope}"
        blocks.append(lines)
    return "\n".join(blocks) if len(blocks) == 1 else "\nor\n".join(blocks)


def trailer_findings(where: str, label: str, text: str, claims: dict[str, dict], mine: list[dict],
                     now: datetime) -> list[tuple[str, str]]:
    """(key, reason) for each way stage 1 would refuse this text's claim reference."""
    text = re.sub(r"\r\n?|[  ]", "\n", text)
    named, scoped = CLAIM_TRAILER.search(text), SCOPE_TRAILER.search(text)
    lines = ("these lines" if len(mine) == 1 else "the lines of the claim this work is under (one of these)") \
        + ", each at the start of its own line:\n" + trailer_lines(mine)
    if named is None:
        if not mine:
            return []  # no live claim: the no-claim report says what to do
        return [(f"trailer:{where}:missing-claim", f"{label} has no `Clued-Work-Claim:` line. Add {lines}")]
    claim_id = named.group(1).lower()
    claim = claims.get(claim_id)
    if claim is None:
        if not mine:
            return []
        return [(f"trailer:{where}:unknown-claim:{claim_id}",
                 f"{label} names claim {claim_id}, which is not a claim recorded in this checkout "
                 f"({CLAIM_FILE.as_posix()}). Use {lines}\nIf you hold that claim from elsewhere, set "
                 "CLUED_WORK_CLAIM=<claim_id>.")]
    if not is_live(claim, now):
        return [(f"lease:{claim_id}:{claim.get('expires_at')}",
                 f"{label} names claim {claim_id}, which is not live by this machine's clock (status "
                 f"{claim.get('status')}, lease until {claim.get('expires_at')}). Renew it with clued_work_renew "
                 "(its fence, lease_version and a new progress_ref) before publishing. A claim that has ended "
                 "needs a new clued_work_claim and new trailer lines.")]
    expected = claim.get("context_key")
    found = scoped.group(1) if scoped else "global"
    if not isinstance(expected, str) or not SCOPE_VALUE.fullmatch(expected) or found == expected:
        return queue_findings(claim_id, claim, label, now)
    if scoped is None:
        return [(f"trailer:{where}:missing-scope:{claim_id}",
                 f"{label} names claim {claim_id} but has no `Clued-Work-Scope:` line, so stage 1 reads the scope "
                 f"as global while the claim is in {expected} (CLAIM_NOT_CURRENT, full_admission_claim_changed). "
                 f"Add this line at the start of its own line:\nClued-Work-Scope: {expected}")]
    return [(f"trailer:{where}:wrong-scope:{claim_id}",
             f"{label} has `Clued-Work-Scope: {found}`, but claim {claim_id} is in {expected}. "
             f"Change that line to:\nClued-Work-Scope: {expected}")]


# Stage 8 publishes kooyumi-merge-slot only for the head of this merge queue
# (independent-control-checks-v2/publisher.mjs queueHeadReady), and a renewal while a batch
# runs changes the binding its publishers compare, voiding that batch (Decision b30b1b79,
# 2026-10-30 #949). So the claim must already be in the queue, with lease enough for one batch.
MERGE_REF = f"merge:{REPOSITORY}:main"
BATCH_LEASE_MINUTES = 90


def queue_findings(claim_id: str, claim: dict, label: str, now: datetime) -> list[tuple[str, str]]:
    """(key, reason) when this live claim would stall at stage 8 or need a renewal mid-batch."""
    findings: list[tuple[str, str]] = []
    refs = claim.get("trigger_refs")
    if isinstance(refs, list) and MERGE_REF not in refs:
        findings.append((f"merge-slot:{claim_id}",
                         f"{label} names claim {claim_id}, whose trigger_refs lack `{MERGE_REF}`, so stage 8 "
                         "waits for a merge slot that never comes (RESIDENT_MERGE_QUEUE_NOT_JOINED). Renew it "
                         f"with that ref added to trigger_refs BEFORE pushing; renewing during the batch voids it. Work that "
                         "will not merge into main (a draft, another base) can simply retry."))
    expires = parse_time(claim.get("expires_at"))
    if expires is not None and (expires - now).total_seconds() < BATCH_LEASE_MINUTES * 60:
        findings.append((f"lease-short:{claim_id}:{claim.get('expires_at')}",
                         f"{label} names claim {claim_id}, whose lease ends at {claim.get('expires_at')}, less "
                         f"than {BATCH_LEASE_MINUTES} minutes from now: one batch can outlast it, and renewing "
                         "while it runs voids the batch. Renew it with clued_work_renew BEFORE pushing."))
    return findings


def publish_findings(payload: dict, claims: dict[str, dict], now: datetime) -> list[tuple[str, str]]:
    """What stage 1 of the CI would refuse in the commits and bodies this call publishes.

    The candidates for the exact lines are this session's live claims, else every live claim here.
    """
    by_id = {str(key).lower(): claim for key, claim in claims.items()}
    live = [claim for claim in by_id.values() if is_live(claim, now)]
    mine = [claim for claim in live if claim.get("session_id") == payload.get("session_id")] or live
    findings: dict[str, str] = {}
    for where, label, text in publish_texts(payload):
        for key, reason in trailer_findings(where, label, text, by_id, mine, now):
            findings.setdefault(key, reason)
    return list(findings.items())


def check_claim(payload: dict) -> int:
    kind = guarded_kind(payload)
    if kind is None or os.environ.get("CLUED_WORK_CLAIM", "").strip():
        return 0
    now = datetime.now(timezone.utc)
    claims = load_claims(project_dir(payload) / CLAIM_FILE)
    try:
        findings = publish_findings(payload, claims, now) if kind == "publish" else []
    except Exception:  # an odd command line must never break the session; the claim check still runs
        findings = []
    if findings:
        reasons = [reason for key, reason in findings if first_report(payload, key)]
        if not reasons:
            return 0
        print(
            "BeamingFace work-claim guard (agent-contract §1.7, Decision 349f6e42 item 2a): stage 1 of the CI "
            "would refuse this. clued-work-admission reads the claim from the pull request body, or from the "
            "head commit when the body names none, and a refused head is released at most twice in 24 hours.\n- "
            + "\n- ".join(reasons)
            + "\nFix the commit message before it is pushed (when the commit is already on the remote, add a new "
            "commit; never force-push) and the body through --body or --body-file, then run the command again. "
            "Each finding is reported once per session; CLUED_WORK_CLAIM_GUARD=off turns the guard off.",
            file=sys.stderr,
        )
        return 2
    if any(is_live(c, now) for c in claims.values()):
        return 0
    if not first_report(payload, kind):
        return 0
    if kind == "publish":
        what = ("This pushes, or opens or edits a pull request. clued-work-admission is enforced on main, so a "
                "pull request without `Clued-Work-Claim: <claim_id>` in its body and head commit is rejected.")
    elif kind == "edit":
        what = "This changes a repository file, which is work on a Task."
    else:
        what = ("This runs an install, build or test, starts CI or dispatches a subtask, which is spending "
                "on the work.")
    print(
        "BeamingFace work-claim guard (agent-contract §1.7): no live work claim is recorded for this checkout. "
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


def messages_enabled(body) -> bool:
    """Only an explicit false in the inbox summary disables messages."""
    inbox = body.get("agent_inbox") if isinstance(body, dict) else None
    return not isinstance(inbox, dict) or inbox.get("messages_enabled") is not False


def messages_disabled_error(response) -> bool:
    """Read only the send refusal, including nested MCP result envelopes."""
    body = response if isinstance(response, dict) else response_body(response)
    if not isinstance(body, dict):
        return False
    error = body.get("error")
    if (body.get("error_code") == "agent_messages_disabled" or error == "agent_messages_disabled"
            or (isinstance(error, dict) and
                (error.get("code") == "agent_messages_disabled"
                 or error.get("error_code") == "agent_messages_disabled"))):
        return True
    return any(messages_disabled_error(body[key]) for key in ("structuredContent", "content") if key in body)


def describe_inbox(unread: int, requests: int) -> str:
    return (f"{unread} unread message(s), {requests} request(s) to you not yet answered")


def inbox_reminder(payload: dict) -> str | None:
    """PostToolUse: the reminder for a resume or renewal that reports messages."""
    if tool_suffix(payload.get("tool_name", "")) not in INBOX_TOOLS:
        return None
    response = payload.get("tool_response")
    # A resume result has no status, so response_body does not take it as is.
    body = response if isinstance(response, dict) and "agent_inbox" in response else response_body(response)
    counts = inbox_counts(body)
    if not counts or not any(counts):
        return None
    how_to = INBOX_HOW_TO if messages_enabled(body) else INBOX_DISABLED_HOW_TO
    return ("BeamingFace agent messages (agent-contract Appendix A.3): other Agents wrote to you through BeamingFace: "
            + describe_inbox(*counts) + ". " + how_to)


def runtime_reminder(payload: dict, now: datetime | None = None) -> str | None:
    """Advise this holder from a fresh service response, never from Task text.

    This hook neither renews a claim nor approves spending. The Agent uses the
    normal service door with fresh progress; expired or draining claims are
    never made live by a reminder. No private capability is echoed or stored.
    """
    if tool_suffix(payload.get("tool_name", "")) not in INBOX_TOOLS | CLAIM_TOOLS:
        return None
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        return None
    response = payload.get("tool_response")
    if isinstance(response, dict) and response.get("isError") is True:
        return None
    body = response if isinstance(response, dict) and "active_work_claims" in response else response_body(response)
    if (not isinstance(body, dict) or body.get("error") or body.get("error_code")
            or body.get("status") not in (None, "committed", "restored", "ok")):
        return None
    claims = body.get("active_work_claims", [])
    if isinstance(body.get("claim"), dict) and body.get("status") == "committed":
        claims = [body["claim"]]
    if not isinstance(claims, list):
        return None
    current = now or datetime.now(timezone.utc)
    messages = []
    for claim in claims:
        if not isinstance(claim, dict) or claim.get("holder_session_ref") != session or claim.get("status") != "ACTIVE":
            continue
        identity = claim.get("claim_id")
        if not isinstance(identity, str) or not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", identity):
            continue
        expires = parse_time(claim.get("expires_at"))
        cap = parse_time(claim.get("hard_deadline_at"))
        if expires is None:
            continue
        label = f"BeamingFace runtime boundary for own claim {identity}: "
        if cap is not None and cap <= current:
            messages.append(label + "the current service claim-chain hard limit is reached. Stop new protected spending; "
                            "use the actual service refusal/recovery or grant route. Do not renew or reclaim to evade it. "
                            "This timestamp is not an Owner-imposed Task deadline.")
        elif expires <= current:
            messages.append(label + "the service lease has expired. Stop work protected by that lease and re-read the current "
                            "claim/profile before using its lawful recovery route. Do not infer an Owner deadline or ask "
                            "for a routine window extension from this timestamp.")
        elif (expires - current).total_seconds() <= 900:
            messages.append(label + "the service lease expires at " + expires.isoformat() + ". Renew it yourself before expiry "
                            "with clued_work_renew, the current fence/lease version and real fresh progress, while the "
                            "service chain limit permits. Preserve Task costs/failures/CI counts. Ordinary queues and "
                            "revised estimates do not require an Owner window-extension question. Historical Task metadata "
                            "and estimates do not establish an Owner hard deadline (agent-contract Appendix A.4).")
    return "\n\n".join(messages) or None


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
    clued_agent_inbox read that did not fail; while messages are enabled,
    reported requests also need a later committed reply_to send. A disabled
    send refusal overrides that summary until a newer summary arrives.
    """
    calls: dict[str, tuple[str, dict]] = {}
    latest: tuple[int, str, tuple[int, int]] | None = None
    reads: list[int] = []
    replies: list[int] = []
    enabled = True
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
                failed = (bool(block.get("is_error")) or not isinstance(body, dict)
                          or bool(body.get("error")) or bool(body.get("error_code"))
                          or body.get("status") in ("rejected", "failed", "error"))
                if name in INBOX_TOOLS:
                    counts = inbox_counts(body)
                    if counts is not None:
                        latest = (pos, use_id, counts)
                        enabled = messages_enabled(body)
                elif name == INBOX_READ_TOOL and not failed:
                    reads.append(pos)
                elif name == MESSAGE_SEND_TOOL:
                    if messages_disabled_error(body):
                        enabled = False
                    elif not failed and tool_input.get("reply_to") and body.get("status") == "committed":
                        replies.append(pos)
    if latest is None or not any(latest[2]):
        return None
    pos, use_id, (unread, requests) = latest
    if not any(read > pos for read in reads):
        state = "unread"
    elif enabled and requests and not any(reply > pos for reply in replies):
        state = "unanswered"
    else:
        return None
    what = "you have not read them" if state == "unread" else "you have not answered any of the requests"
    how_to = INBOX_HOW_TO if enabled else INBOX_DISABLED_HOW_TO
    key_state = state if enabled else f"{state}:messages-disabled"
    other_answer = " If you answered them in another way, say so in your reply." if enabled else ""
    return (f"inbox:{use_id}:{key_state}",
            "BeamingFace agent messages (agent-contract Appendix A.3): the latest resume or renewal reported "
            + describe_inbox(unread, requests) + f", and {what}. " + how_to
            + other_answer + " Reported once in each state.")


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
        return "the public BeamingFace database config could not be read"
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
            lines.append(f"Live claims from BeamingFace are unavailable: {live}. clued_session_resume lists them.")
        elif live:
            lines.append("Live claims in BeamingFace (check these before you start; do not overlap them):")
            lines += [describe(c) for c in live[:10]]
        else:
            lines.append("BeamingFace reports no live claims.")
    else:
        lines.append("clued_session_resume lists the live claims (active_work_claims); check them before you start.")
    return "\n".join(lines)


def main() -> int:
    if os.environ.get("CLUED_WORK_CLAIM_GUARD", "").lower() == "off":
        return 0
    try:
        # Claude Code sends UTF-8 whatever the console code page is.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    event = payload.get("hook_event_name")
    if event == "PreToolUse":
        return check_claim(payload)
    if event == "PostToolUse":
        record_claim(payload)
        reminders = [value for value in (inbox_reminder(payload), runtime_reminder(payload)) if value]
        if reminders:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                                     "additionalContext": "\n\n".join(reminders)}}))
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
