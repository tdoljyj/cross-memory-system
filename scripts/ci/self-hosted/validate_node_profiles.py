#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "scripts" / "ci" / "self-hosted"
PROFILE_PATH = BASE / "node-profiles.json"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
WIN_NAME = re.compile(r"^clued-ci-(home|company|other)-win-[0-9]{2}$")
LINUX_NAME = re.compile(r"^clued-ci-(home|company|other)-linux-[0-9]{2}$")

def fail(errors: list[str], message: str) -> None:
    errors.append(message)

def main() -> int:
    data = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    errors: list[str] = []
    if data.get("schema") != "clued.self-hosted-node-profiles/v1":
        fail(errors, "unexpected schema")

    package = data.get("runner_package", {})
    version = package.get("version")
    for key in ("windows_x64_sha256", "linux_x64_sha256"):
        value = package.get(key, "")
        if not isinstance(value, str) or not HEX64.fullmatch(value):
            fail(errors, f"invalid runner package digest: {key}")

    runner_profiles = data.get("runner_profiles", {})
    capacity_profiles = data.get("capacity_profiles", {})
    lifecycle_states = set(data.get("lifecycle_states", []))
    if not runner_profiles or not capacity_profiles or not lifecycle_states:
        fail(errors, "runner_profiles, capacity_profiles, and lifecycle_states must be non-empty")

    for name, profile in capacity_profiles.items():
        required = (
            "minimum_host_memory_gb", "wsl_memory_gb", "wsl_processors", "wsl_swap_gb",
            "watchdog_interval_seconds", "suspend_free_memory_gb", "resume_free_memory_gb",
            "suspend_c_free_gb", "resume_c_free_gb",
        )
        missing = [key for key in required if key not in profile]
        if missing:
            fail(errors, f"{name} missing capacity keys: {', '.join(missing)}")
            continue
        if profile["wsl_memory_gb"] >= profile["minimum_host_memory_gb"]:
            fail(errors, f"{name} must leave host memory headroom")
        if profile["suspend_free_memory_gb"] >= profile["resume_free_memory_gb"]:
            fail(errors, f"{name} memory hysteresis is invalid")
        if profile["suspend_c_free_gb"] >= profile["resume_c_free_gb"]:
            fail(errors, f"{name} disk hysteresis is invalid")
        if profile["wsl_processors"] <= 0 or profile["watchdog_interval_seconds"] < 15:
            fail(errors, f"{name} processor/watchdog values are invalid")

    host_ids: set[str] = set()
    hostnames: set[str] = set()
    runner_names: set[str] = set()
    for host in data.get("hosts", []):
        host_id = host.get("host_id", "")
        hostname = host.get("hostname", "")
        site = host.get("site", "")
        state = host.get("state", "")
        capacity = host.get("capacity_profile", "")
        if host_id in host_ids:
            fail(errors, f"duplicate host_id: {host_id}")
        host_ids.add(host_id)
        if hostname.lower() in hostnames:
            fail(errors, f"duplicate hostname: {hostname}")
        hostnames.add(hostname.lower())
        if site not in {"home", "company", "other"}:
            fail(errors, f"{host_id}: invalid site {site}")
        if state not in lifecycle_states:
            fail(errors, f"{host_id}: invalid lifecycle state {state}")
        if capacity not in capacity_profiles:
            fail(errors, f"{host_id}: unknown capacity profile {capacity}")

        for kind, regex in (("windows_runner", WIN_NAME), ("linux_runner", LINUX_NAME)):
            runner = host.get(kind)
            if not runner:
                continue
            name = runner.get("name", "")
            profile_name = runner.get("profile", "")
            profile = runner_profiles.get(profile_name)
            if not profile:
                fail(errors, f"{host_id}/{kind}: unknown runner profile {profile_name}")
                continue
            if name in runner_names:
                fail(errors, f"duplicate runner name: {name}")
            runner_names.add(name)
            if not regex.fullmatch(name):
                fail(errors, f"{host_id}/{kind}: non-canonical runner name {name}")
            if f"-{site}-" not in name:
                fail(errors, f"{host_id}/{kind}: runner site does not match host site")
            required_labels = set(profile.get("required_custom_labels", []))
            allowed_labels = required_labels | set(profile.get("optional_custom_labels", []))
            capabilities = set(runner.get("capabilities", []))
            capability_required = {label for label in required_labels if label.startswith("cap-") or label.startswith("runtime-")}
            if not capability_required <= capabilities:
                fail(errors, f"{host_id}/{kind}: missing required capabilities {sorted(capability_required - capabilities)}")
            if not capabilities <= allowed_labels:
                fail(errors, f"{host_id}/{kind}: undeclared capabilities {sorted(capabilities - allowed_labels)}")

    windows_bootstrap = (BASE / "bootstrap-windows-runner.ps1").read_text(encoding="utf-8")
    linux_bootstrap = (BASE / "bootstrap-linux-runner.sh").read_text(encoding="utf-8")
    if f"RunnerVersion = '{version}'" not in windows_bootstrap:
        fail(errors, "Windows bootstrap runner version drift")
    if package.get("windows_x64_sha256") not in windows_bootstrap:
        fail(errors, "Windows bootstrap digest drift")
    if f'RUNNER_VERSION="{version}"' not in linux_bootstrap:
        fail(errors, "Linux bootstrap runner version drift")
    if package.get("linux_x64_sha256") not in linux_bootstrap:
        fail(errors, "Linux bootstrap digest drift")

    report = {
        "schema": "clued.self-hosted-node-profile-validation/v1",
        "status": "PASS" if not errors else "FAIL",
        "hosts": len(host_ids),
        "runners": len(runner_names),
        "capacity_profiles": sorted(capacity_profiles),
        "runner_profiles": sorted(runner_profiles),
        "errors": errors,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
