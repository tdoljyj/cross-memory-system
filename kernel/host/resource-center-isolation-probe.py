"""No credentials or provider mounts; test the disposable sandbox boundary."""
import json
import os
import socket
import subprocess

checks = {}
for label, target in {
    "windows_disk_hidden": "/mnt/c",
    "drive_mount_hidden": "/mnt/g",
    "host_home_hidden": "/home",
    "host_credentials_hidden": "/root/.codex",
    "host_process_root_hidden": "/proc/1/root/mnt/c",
    "wsl_interop_hidden": "/run/WSL",
}.items():
    checks[label] = not os.path.exists(target)
with open('/proc/self/mountinfo', encoding='ascii') as mount_file:
    mounts = [line.split() for line in mount_file]
checks['host_tmp_hidden'] = any(parts[4] == '/tmp' and parts[parts.index('-') + 1] == 'tmpfs' for parts in mounts)
status = {}
with open('/proc/self/status', encoding='ascii') as file:
    for line in file:
        key, _, value = line.partition(':')
        if key in ('CapEff', 'CapPrm', 'CapBnd', 'NoNewPrivs'):
            status[key] = value.strip()
checks['capabilities_removed'] = all(int(status[k], 16) == 0 for k in ('CapEff', 'CapPrm', 'CapBnd'))
checks['no_new_privileges'] = status['NoNewPrivs'] == '1'
checks['environment_scrubbed'] = not any(k in os.environ for k in ('WSL_INTEROP', 'WSLENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'LOCALAPPDATA'))
extra_fds = []
for descriptor in os.listdir('/proc/self/fd'):
    if int(descriptor) > 2:
        try:
            os.readlink('/proc/self/fd/' + descriptor)
            extra_fds.append(descriptor)
        except FileNotFoundError:
            pass
checks['inherited_fds_limited_to_stdio'] = not extra_fds
try:
    with open('/usr/.clued-gateb-readonly-probe', 'x', encoding='ascii') as file:
        file.write('unexpected')
    checks['system_runtime_readonly'] = False
    os.unlink('/usr/.clued-gateb-readonly-probe')
except (PermissionError, OSError):
    checks['system_runtime_readonly'] = True
with socket.socket() as client:
    client.settimeout(1)
    try:
        client.connect(('1.1.1.1', 443))
        checks['network_isolated'] = False
    except OSError:
        checks['network_isolated'] = True
result = subprocess.run(['/usr/bin/unshare', '--user', '/usr/bin/true'], capture_output=True, timeout=2)
checks['nested_user_namespace_denied'] = result.returncode != 0
print(json.dumps({'status': 'PASS' if all(checks.values()) else 'FAIL', 'checks': checks,
                  'host_or_drive_mutations': 0, 'qualification': 'OS_PROBE_ONLY_NOT_AGENT_OR_WRITER_QUALIFICATION'}))
raise SystemExit(0 if all(checks.values()) else 1)
