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
ROUTE_LABEL = re.compile(r"^runner-(home|company|other)-(win|linux)-[0-9]{2}$")

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
            "suspend_free_memory_gb", "resume_free_memory_gb",
        )
        missing = [key for key in required if key not in profile]
        if missing:
            fail(errors, f"{name} missing capacity keys: {', '.join(missing)}")
            continue
        if profile["wsl_memory_gb"] >= profile["minimum_host_memory_gb"]:
            fail(errors, f"{name} must leave host memory headroom")
        if profile["suspend_free_memory_gb"] >= profile["resume_free_memory_gb"]:
            fail(errors, f"{name} memory hysteresis is invalid")
        # Disk levels are the node governance standard's (config/node-governance-standard.json), not a profile's.
        stale = [key for key in profile if key.endswith("_c_free_gb") or key.endswith("_runner_disk_free_gb") or key == "watchdog_interval_seconds"]
        if stale:
            fail(errors, f"{name} has disk or watchdog keys the governance standard now holds: {', '.join(stale)}")
        if profile["wsl_processors"] <= 0:
            fail(errors, f"{name} processor values are invalid")

    host_ids: set[str] = set()
    hostnames: set[str] = set()
    runner_names: set[str] = set()
    route_labels: set[str] = set()
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

        # Node governance v1: one governance block per host (render.ps1 checks the same).
        gov = host.get("governance")
        if "watchdog_drives" in host or "watchdog_path" in host:
            fail(errors, f"{host_id}: watchdog_drives/watchdog_path are gone; declare the governance block")
        if not isinstance(gov, dict) or set(gov) - {"drives", "resident_distro", "worktrees", "overrides"}:
            fail(errors, f"{host_id}: governance must be an object of drives, resident_distro, worktrees, overrides")
        else:
            letters = gov.get("drives")
            if not isinstance(letters, list) or not letters or not all(isinstance(x, str) and re.fullmatch(r"[A-Z]", x) for x in letters) or len(set(letters)) != len(letters):
                fail(errors, f"{host_id}: governance.drives must be a non-empty list of distinct single drive letters")
            distro = gov.get("resident_distro")
            if distro is not None and not (isinstance(distro, str) and re.fullmatch(r"[A-Za-z0-9._-]+", distro)):
                fail(errors, f"{host_id}: governance.resident_distro must be a distribution name")
            worktrees = gov.get("worktrees", [])
            if not isinstance(worktrees, list) or not all(isinstance(w, str) and re.fullmatch(r"[A-Za-z]:\\[^\"'`$]*", w) for w in worktrees):
                fail(errors, f"{host_id}: governance.worktrees must be a list of absolute Windows paths")
            if not isinstance(gov.get("overrides", {}), dict):
                fail(errors, f"{host_id}: governance.overrides must be an object")

        additional = host.get("additional_linux_runners", [])
        if not isinstance(additional, list):
            fail(errors, f"{host_id}: additional_linux_runners must be a list")
            additional = []
        if additional and not host.get("linux_runner"):
            fail(errors, f"{host_id}: additional_linux_runners require a primary linux_runner")
        primary_linux = host.get("linux_runner") or {}
        entries = [(kind, regex, host.get(kind)) for kind, regex in (("windows_runner", WIN_NAME), ("linux_runner", LINUX_NAME))]
        entries += [(f"additional_linux_runners[{index}]", LINUX_NAME, runner) for index, runner in enumerate(additional)]
        for kind, regex, runner in entries:
            if not runner:
                continue
            if kind.startswith("additional_linux_runners"):
                # Extra slots share the primary WSL distro, user and watchdog.
                for key in ("distro", "user"):
                    if runner.get(key) != primary_linux.get(key):
                        fail(errors, f"{host_id}/{kind}: {key} must match the primary linux_runner")
                for key in ("root", "service_unit"):
                    if not runner.get(key) or runner.get(key) == primary_linux.get(key):
                        fail(errors, f"{host_id}/{kind}: {key} must be set and distinct from the primary linux_runner")
                if runner.get("manage_native_docker"):
                    fail(errors, f"{host_id}/{kind}: only the primary linux_runner may manage native Docker")
            runner_state = runner.get("state", state)
            if runner_state not in lifecycle_states:
                fail(errors, f"{host_id}/{kind}: invalid lifecycle state {runner_state}")
            route_label = runner.get("route_label")
            if route_label is not None:
                if not isinstance(route_label, str) or not ROUTE_LABEL.fullmatch(route_label):
                    fail(errors, f"{host_id}/{kind}: non-canonical route_label {route_label}")
                elif route_label in route_labels:
                    fail(errors, f"duplicate route_label: {route_label}")
                elif route_label.removeprefix("runner-") != runner.get("name", "").removeprefix("clued-ci-"):
                    fail(errors, f"{host_id}/{kind}: route_label must name its own runner")
                route_labels.add(route_label)
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
            if kind == "windows_runner":
                # Windows runners run as a service under a dedicated account; the
                # login-session watchdog must not have a launcher to start them with.
                expected_service = f"actions.runner.{data.get('repository', '').replace('/', '-')}.{name}"
                if runner.get("service_name") != expected_service:
                    fail(errors, f"{host_id}/{kind}: service_name must be {expected_service}")
                if "launcher" in runner:
                    fail(errors, f"{host_id}/{kind}: launcher is not allowed; the runner is a Windows service")

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
    containment_fragments = (
        "KillMode=control-group",
        "20-clued-process-containment.conf",
        "systemctl daemon-reload",
        "systemctl show -p KillMode --value",
    )
    for fragment in containment_fragments:
        if fragment not in linux_bootstrap:
            fail(errors, f"Linux bootstrap service containment drift: missing {fragment}")

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
