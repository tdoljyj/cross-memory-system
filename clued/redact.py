# -*- coding: utf-8 -*-
"""秘密脱敏（协议 §3.9 / §15.1）。

模式唯一事实源 = 仓库根 guards.json（与同步层共用，不重复定义）。
日志、诊断、审计、错误信息中的凭据样值一律掩码。
"""

import json
import os
import re

from .paths import resolve_repo

_FALLBACK_PATTERNS = [
    "gh[op]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "AKIA[0-9A-Z]{16}",
    "-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "(?i)bearer\\s+[A-Za-z0-9._-]{20,}",
]

_COMPILED = None
_MASK = "***REDACTED***"


def secret_patterns(repo=None):
    global _COMPILED
    if _COMPILED is not None:
        return _COMPILED
    patterns = list(_FALLBACK_PATTERNS)
    try:
        guards_path = os.path.join(repo or resolve_repo(), "guards.json")
        if os.path.isfile(guards_path):
            with open(guards_path, "r", encoding="utf-8") as fh:
                declared = (json.load(fh) or {}).get("secret_patterns") or []
            if declared:
                patterns = list(declared)
    except Exception:
        pass
    _COMPILED = [re.compile(p) for p in patterns]
    return _COMPILED


def redact(text):
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    out = text
    for pat in secret_patterns():
        out = pat.sub(_MASK, out)
    return out


def contains_secret(text):
    if not isinstance(text, str) or not text:
        return False
    for pat in secret_patterns():
        if pat.search(text):
            return True
    return False
