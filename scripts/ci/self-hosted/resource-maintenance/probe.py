#!/usr/bin/env python3
"""Read only the registered maintenance report and emit a bounded public summary."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import maintenance as m


def summary(manager, now=None):
    manager.validate()
    report_path = manager.state / "report.json"
    if not report_path.exists():
        return {"status": "never-ran", "node_id": manager.node}
    row = m.load_json(report_path)
    m.require(row.get("schema") == "clued.cache-maintenance-report/1" and row.get("node_id") == manager.node,
              "REPORT_BINDING")
    m.require(row.get("registry_sha256") == manager.registry_sha and row.get("binding_sha256") == manager.binding_sha,
              "REPORT_PIN")
    at = row.get("at")
    m.require(type(at) in (int, float) and 0 <= at <= (1 << 60) and math.isfinite(at), "REPORT_TIME")
    age = (time.time() if now is None else now) - at
    m.require(age >= -300, "REPORT_FUTURE")
    status = row.get("status")
    m.require(status in ("ok", "deferred", "partial", "capacity-low"), "REPORT_STATUS")
    budget = manager.policy["interval_seconds"] * 2 + manager.policy["stagger_seconds"] + 300
    status = "stale" if age > budget else status
    removed = row.get("removed_bytes")
    m.require(type(removed) is int and 0 <= removed <= manager.policy["max_remove_bytes"], "REPORT_BYTES")
    deferred = row.get("deferred", [])
    m.require(type(deferred) is list, "REPORT_DEFERRED")
    return {"node_id": manager.node, "status": status, "at": at, "age_seconds": max(0, int(age)),
            "stale_after_seconds": budget, "removed_bytes": removed, "deferred_count": len(deferred), "tool_version": m.VERSION}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, default=Path(__file__).resolve().parents[4] / "config" / "ci-resource-maintenance.json")
    parser.add_argument("--binding", type=Path)
    args = parser.parse_args()
    binding = args.binding or (Path(os.environ["CLUED_CACHE_NODE_BINDING"]) if os.environ.get("CLUED_CACHE_NODE_BINDING") else None)
    if binding is None:
        result = {"status": "not-registered"}
    else:
        try:
            result = summary(m.Manager(m.load_json(args.registry), m.load_json(binding)))
        except (m.Refused, OSError, ValueError, KeyError, TypeError):
            result = {"status": "invalid"}
    print("CACHE_MAINTENANCE_PROBE " + json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
