# -*- coding: utf-8 -*-
"""Strict allowlist-only, privacy-gated R5.1 telemetry."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Dict, Iterable


@dataclass(frozen=True)
class EnumField:
    allowed: frozenset

    def __init__(self, allowed: Iterable[str]):
        object.__setattr__(self, "allowed", frozenset(str(x) for x in allowed))

    def encode(self, value):
        value = str(value)
        if value not in self.allowed:
            raise ValueError("enum rejected")
        return value


@dataclass(frozen=True)
class BucketField:
    boundaries: tuple

    def __init__(self, boundaries: Iterable[float]):
        object.__setattr__(
            self, "boundaries", tuple(sorted(float(x) for x in boundaries)))

    def encode(self, value):
        number = float(value)
        for boundary in self.boundaries:
            if number <= boundary:
                return "le_%s" % ("%g" % boundary)
        return "gt_%s" % ("%g" % self.boundaries[-1])


DEFAULT_CONTRACT: Dict[str, Dict[str, object]] = {
    "lifecycle_result": {
        "action": EnumField(
            ("install", "update", "repair", "disable", "enable", "uninstall")),
        "state": EnumField(
            ("STAGED", "COMMITTED", "ROLLED_BACK", "FINALIZED",
             "RECOVERY_NEEDED")),
        "duration_ms": BucketField((10, 50, 100, 500, 1000, 5000)),
    },
    "doctor_result": {
        "status": EnumField(
            ("AVAILABLE", "DEGRADED", "BROKEN", "DENIED", "TIMEOUT")),
        "adapter_count": BucketField((0, 1, 2, 4, 8, 16)),
    },
    "sync_result": {
        "state": EnumField(("ONLINE", "DEGRADED", "LOCKED")),
        "outbox_count": BucketField((0, 1, 5, 10, 50, 100, 1000)),
    },
}


class TelemetryClient:
    """Apply DNT/CI/disabled/no-key gates on every attempted send."""

    def __init__(self, sender: Callable[[str, dict], None], *,
                 telemetry_key=None, enabled=False, environment=None,
                 contract=None):
        self.sender = sender
        self.telemetry_key = telemetry_key
        self.enabled = bool(enabled)
        self.environment = environment if environment is not None else os.environ
        self.contract = contract or DEFAULT_CONTRACT

    @staticmethod
    def _truthy(value):
        return str(value or "").strip().lower() in ("1", "true", "yes", "on")

    def _gate(self):
        if not self.enabled:
            return "disabled"
        if self._truthy(self.environment.get("DO_NOT_TRACK")):
            return "do_not_track"
        if self._truthy(self.environment.get("CI")):
            return "ci"
        if not self.telemetry_key:
            return "missing_key"
        return None

    def emit(self, event: str, values: dict):
        gate = self._gate()
        if gate:
            return {"sent": False, "reason": gate}
        fields = self.contract.get(str(event))
        if fields is None:
            return {"sent": False, "reason": "event_not_allowed"}
        if set(values) - set(fields):
            return {"sent": False, "reason": "field_not_allowed"}
        encoded = {}
        try:
            for key, value in values.items():
                encoded[key] = fields[key].encode(value)
        except Exception:
            return {"sent": False, "reason": "value_not_allowed"}
        envelope = {
            "event": str(event),
            "fields": encoded,
            "contract_version": "r5.1-telemetry/v1",
        }
        try:
            self.sender(self.telemetry_key, envelope)
        except Exception:
            return {"sent": False, "reason": "transport_failed"}
        return {"sent": True, "reason": "sent"}
