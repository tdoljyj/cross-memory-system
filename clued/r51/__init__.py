# -*- coding: utf-8 -*-
"""Clued Kernel R5.1 beta-candidate building blocks.

The package keeps semantic recall disabled and adds only the lexical,
transaction, sync and operational contracts required by R5.1.
"""

from .idempotency import CallerIdentity, IdempotencyConflict, MutationReceiptStore

__all__ = ["CallerIdentity", "IdempotencyConflict", "MutationReceiptStore"]
