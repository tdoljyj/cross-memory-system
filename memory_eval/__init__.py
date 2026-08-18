# -*- coding: utf-8 -*-
"""Memory Eval（MIV-001）：固定评测框架（schema / corpus / runner）。"""

from .corpus import CASES, FAKE_TOKEN, corpus_hash  # noqa: F401
from .runner import (  # noqa: F401
    ADAPTER_IDS, RUNNER_VERSION, compute_metrics, load_fixtures,
    render_markdown, run_all, run_case,
)
from .schema import (  # noqa: F401
    CATEGORIES, CATEGORY_MIN_QUOTA, CRITICAL_ASSERTIONS, SCHEMA_VERSION,
    SCOPE_MODES, assert_case_has_no_secrets, scope_to_engine, validate_case,
)

__version__ = "1.0"
