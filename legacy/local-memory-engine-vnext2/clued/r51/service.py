# -*- coding: utf-8 -*-
"""Shared R5.1 Kernel service for CLI and AI-conversation entry points."""

from __future__ import annotations

import time
from typing import Iterable, Optional

from .activation import TransactionalInstallationEngine
from .probe import AdapterSelector, ProbeRunner
from .telemetry import TelemetryClient


class KernelService:
    def __init__(self, root: str, *, adapter_candidates: Iterable[dict] = (),
                 protected_paths: Iterable[str] = (),
                 telemetry: Optional[TelemetryClient] = None,
                 installation_engine=None, clock=time.time):
        self.root = root
        self.adapter_candidates = list(adapter_candidates)
        self.protected_paths = tuple(protected_paths)
        self.telemetry = telemetry
        self.installation = installation_engine or (
            TransactionalInstallationEngine(root))
        self.clock = clock

    @staticmethod
    def default_managed(enabled=True):
        return {
            "enabled": bool(enabled),
            "lexical_recall_provider": "clued-postgres-fts/v1",
            "semantic_recall_enabled": False,
        }

    def lifecycle(self, action: str):
        started = self.clock()
        if action == "uninstall":
            managed = None
        elif action == "disable":
            managed = self.default_managed(False)
        else:
            managed = self.default_managed(True)
        result = self.installation.execute(action, managed=managed)
        if self.telemetry is not None:
            self.telemetry.emit("lifecycle_result", {
                "action": action,
                "state": result["state"],
                "duration_ms": max(0, (self.clock() - started) * 1000),
            })
        return result

    def doctor(self):
        # Each Adapter receives all credential/config/Binding paths as a
        # byte-and-state immutability boundary.
        candidates = []
        for candidate in self.adapter_candidates:
            copy = dict(candidate)
            protected = set(copy.get("protected_paths", ()))
            protected.update(self.protected_paths)
            copy["protected_paths"] = sorted(protected)
            candidates.append(copy)
        selected = AdapterSelector(ProbeRunner()).select(candidates)
        result = {
            "status": selected["status"],
            "active_backend": selected["active_backend"],
            "ordered_candidates": selected["ordered_candidates"],
            "probes": selected["probes"],
            "semantic_recall_enabled": False,
            "read_only": True,
        }
        if self.telemetry is not None:
            self.telemetry.emit("doctor_result", {
                "status": result["status"],
                "adapter_count": len(candidates),
            })
        return result

    def dispatch(self, command: str):
        """AI Conversation and CLI both call this exact engine boundary."""
        command = str(command or "").lower()
        if command == "doctor":
            return self.doctor()
        if command == "recover":
            return self.installation.recover()
        return self.lifecycle(command)
