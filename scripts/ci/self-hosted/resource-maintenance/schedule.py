#!/usr/bin/env python3
"""Render a local scheduler definition; never register or start it implicitly."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import maintenance as m


def render(manager, registry_path, binding_path, platform, executable=None):
    manager.validate()
    script = Path(__file__).resolve().with_name("maintenance.py")
    executable = Path(executable or sys.executable).resolve()
    args = [str(script), "--registry", str(Path(registry_path).resolve()),
            "--registry-sha256", manager.registry_sha, "--binding", str(Path(binding_path).resolve()), "worker"]
    name = "clued-cache-" + manager.node
    if platform == "windows":
        m.require(os.name == "nt", "WINDOWS_RENDER_REQUIRES_WINDOWS_IDENTITY")
        # S4U runs without an interactive desktop/password. It has no network or
        # EFS access; only this account's new local cache roots are supported.
        pythonw = executable.with_name("pythonw.exe")
        m.require(pythonw.is_file(), "PYTHONW_REQUIRED")
        ns = "http://schemas.microsoft.com/windows/2004/02/mit/task"
        ET.register_namespace("", ns)
        task = ET.Element("{" + ns + "}Task", version="1.4")
        def add(parent, tag, value=None, **attributes):
            node = ET.SubElement(parent, "{" + ns + "}" + tag, attributes)
            if value is not None:
                node.text = value
            return node
        triggers = add(task, "Triggers")
        timed = add(triggers, "TimeTrigger")
        repeat = add(timed, "Repetition")
        add(repeat, "Interval", "PT5M")
        add(repeat, "StopAtDurationEnd", "false")
        add(timed, "StartBoundary", datetime.now(timezone.utc).replace(microsecond=0).isoformat())
        add(timed, "Enabled", "true")
        logon = add(triggers, "LogonTrigger")
        add(logon, "Enabled", "true")
        add(logon, "UserId", manager.owner)
        principal = add(add(task, "Principals"), "Principal", id="LocalCacheOwner")
        add(principal, "UserId", manager.owner)
        add(principal, "LogonType", "S4U")
        add(principal, "RunLevel", "LeastPrivilege")
        settings = add(task, "Settings")
        add(settings, "MultipleInstancesPolicy", "IgnoreNew")
        add(settings, "DisallowStartIfOnBatteries", "false")
        add(settings, "StopIfGoingOnBatteries", "false")
        add(settings, "StartWhenAvailable", "true")
        add(settings, "ExecutionTimeLimit", "PT0S")
        restart = add(settings, "RestartOnFailure")
        add(restart, "Interval", "PT1M")
        add(restart, "Count", "3")
        action = add(add(task, "Actions", Context="LocalCacheOwner"), "Exec")
        add(action, "Command", str(pythonw))
        add(action, "Arguments", subprocess.list2cmdline(args))
        add(action, "WorkingDirectory", str(script.parent))
        return {name + ".xml": ET.tostring(task, encoding="unicode", xml_declaration=True)}
    m.require(platform == "linux", "PLATFORM")
    # systemd specifier and environment expansion must not reinterpret a path.
    def quote(value):
        value = str(value)
        m.require(not any(c in value for c in "\r\n\x00"), "SCHEDULER_PATH")
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'
    command = " ".join(quote(v) for v in [executable, *args])
    return {name + ".service": "\n".join([
        "[Unit]", "Description=Clued registered local cache maintenance", "",
        "[Service]", "Type=simple", "ExecStart=" + command, "Restart=on-failure", "RestartSec=60",
        "UMask=0077", "NoNewPrivileges=true", "StandardOutput=journal", "StandardError=journal", "",
        "[Install]", "WantedBy=default.target", ""])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--registry-sha256", required=True)
    parser.add_argument("--binding", required=True, type=Path)
    parser.add_argument("--platform", choices=["windows", "linux"], required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    registry, binding = m.load_json(args.registry), m.load_json(args.binding)
    m.require(m.digest(registry) == args.registry_sha256, "REGISTRY_PIN")
    manager = m.Manager(registry, binding)
    outputs = render(manager, args.registry, args.binding, args.platform)
    m.require(not args.out.exists(), "OUTPUT_ALREADY_EXISTS")
    m.private_dir(args.out)
    for name, content in outputs.items():
        with (args.out / name).open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
    m.write_json(args.out / "manifest.json", {"schema": "clued.cache-schedule/1", "node_id": manager.node,
        "registry_sha256": manager.registry_sha, "binding_sha256": manager.binding_sha,
        "files": {name: m.hashlib.sha256(content.encode()).hexdigest() for name, content in outputs.items()},
        "installed": False}, exclusive=True)
    m.emit({"status": "RENDERED_NOT_INSTALLED", "node_id": manager.node, "files": list(outputs)})


if __name__ == "__main__":
    main()
