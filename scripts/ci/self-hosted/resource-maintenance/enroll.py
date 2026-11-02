#!/usr/bin/env python3
"""One provisioning entry for any node; creates new managed roots, never adopts old caches."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import maintenance as m
import schedule


def enroll(registry, node_id, root):
    m.require(type(node_id) is str and m.ID.fullmatch(node_id), "NODE_ID")
    root = Path(root)
    m.require(root.is_absolute() and root == root.resolve() and len(root.parts) >= 3, "ROOT_PATH")
    m.require(not root.exists(), "ENROLL_ROOT_MUST_BE_NEW")
    # Credentials, receipts and diagnostic logs are outside the four disposable roots.
    binding = {"schema": "clued.cache-node/1", "node_id": node_id, "state_root": str(root / "state"),
        "caches": {name: {"profile": name, "root": str(root / name)} for name in ("npm", "pip", "job-temp", "generic")}}
    manager = m.Manager(registry, binding)
    m.private_dir(root)
    binding_path = root / "binding.json"
    m.write_json(binding_path, binding, exclusive=True)
    manager.initialize()
    return manager, binding_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--registry-sha256", required=True)
    args = parser.parse_args()
    registry = m.load_json(args.registry)
    m.require(m.digest(registry) == args.registry_sha256, "REGISTRY_PIN")
    manager, binding = enroll(registry, args.node_id, args.root)
    outputs = schedule.render(manager, args.registry, binding, "windows" if os.name == "nt" else "linux")
    destination = args.root / "scheduler"
    m.private_dir(destination)
    for name, content in outputs.items():
        with (destination / name).open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
    m.emit({"status": "ENROLLED_SCHEDULER_NOT_INSTALLED", "node_id": manager.node,
            "binding": str(binding), "scheduler": str(destination), "registry_sha256": manager.registry_sha})


if __name__ == "__main__":
    main()
