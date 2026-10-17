#!/usr/bin/env bash
# Version: 1.0.0. Run only in a new, dedicated Hyper-V Ubuntu guest.
# This prepares an UNQUALIFIED base; it never registers or starts an Actions job.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

VERSION=1.0.0
RUNNER_USER=clued-release-runner
RUNNER_ROOT=/opt/clued-release-runner
BASE_ROOT=/opt/clued-production-publisher
MANIFEST="$BASE_ROOT/base-manifest.json"
RUNNER_VERSION=2.337.0
RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
ARCHIVE="$BASE_ROOT/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
PACKAGES=(git curl ca-certificates jq python3 unzip zstd docker.io libicu74
  libssl3t64 libkrb5-3 zlib1g liblttng-ust1t64 tar gzip util-linux passwd procps)

usage() {
  cat <<'EOF'
Usage: clued-production-vm-guest-init.sh --prepare-base | --check-only

--prepare-base: root, once, in a fresh Hyper-V Ubuntu 24.04 amd64 guest.
  Uses signed official Ubuntu repositories, creates one locked runner user
  without sudo, starts only the guest's Docker Engine, and verifies/extracts
  the repository-pinned Actions runner. No registration, runner service,
  GitHub token, production Binding, production secret or Host mount is used.
--check-only: root, read-only baseline checks; emits one JSON observation.

The manifest remains nonproduction/unqualified. The Host must separately
verify and seal the stopped image, sanitize its own initial-access/NoCloud
material, and qualify each disposable execution. This script never deletes
unknown SSH keys, cloud-init data or user files. Node is workflow-managed.
EOF
}
die() { printf 'Guest base initialization failed: %s\n' "$1" >&2; exit 1; }
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
case "$1" in
  --prepare-base) MODE=prepare ;;
  --check-only) MODE=check ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $(id -u) -eq 0 ]] || die 'root is required inside the new guest.'
for command in python3 systemd-detect-virt findmnt dpkg-query sha256sum getent; do
  command -v "$command" >/dev/null || die "trusted Ubuntu image lacks $command."
done

# Validate before package/network operations and again during every check.
# Python parses data; it never sources os-release or apt configuration as code.
validate_guest_and_apt() {
  python3 - <<'PY'
import pathlib, re, shlex, subprocess, sys, urllib.parse
def require(ok, message):
    if not ok: raise SystemExit(message)
os_release = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
require(os_release.get('ID', '').strip('"') == 'ubuntu' and
        os_release.get('VERSION_ID', '').strip('"') == '24.04', 'Ubuntu 24.04 is required')
require(subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip() == 'amd64', 'amd64 is required')
require(subprocess.check_output(['systemd-detect-virt', '--vm'], text=True).strip() == 'microsoft',
        'a dedicated Hyper-V guest is required; WSL/container/physical hosts are refused')
require(pathlib.Path('/proc/1/comm').read_text().strip() == 'systemd', 'guest systemd must be PID 1')
keyring = '/usr/share/keyrings/ubuntu-archive-keyring.gpg'
require(pathlib.Path(keyring).is_file(), 'Ubuntu archive keyring is missing')
keyring_check = subprocess.run(['dpkg', '--verify', 'ubuntu-keyring'], capture_output=True, text=True)
require(keyring_check.returncode == 0 and keyring_check.stdout == '',
        'Ubuntu keyring package has modified files')
allowed_suites = {'noble', 'noble-updates', 'noble-security', 'noble-backports'}
def uri_ok(value):
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ''
    return (parsed.scheme in {'http', 'https'} and not parsed.username and not parsed.password
            and parsed.port is None and not parsed.query and not parsed.fragment
            and (host in {'archive.ubuntu.com', 'security.ubuntu.com'} or
                 re.fullmatch(r'[a-z]{2}\.archive\.ubuntu\.com', host))
            and parsed.path.rstrip('/') == '/ubuntu')
active = 0
sources = [pathlib.Path('/etc/apt/sources.list')]
sources += sorted(pathlib.Path('/etc/apt/sources.list.d').glob('*.list'))
sources += sorted(pathlib.Path('/etc/apt/sources.list.d').glob('*.sources'))
for source in sources:
    if not source.exists(): continue
    require(not source.is_symlink(), 'apt source symlinks are refused')
    text = source.read_text()
    if source.suffix == '.sources':
        for paragraph in re.split(r'\n\s*\n', text):
            fields, last = {}, None
            for line in paragraph.splitlines():
                if not line.strip() or line.lstrip().startswith('#'): continue
                if line[:1].isspace() and last:
                    fields[last] += ' ' + line.strip(); continue
                require(':' in line, 'invalid deb822 source')
                key, value = line.split(':', 1)
                last = key.lower(); fields[last] = value.strip()
            if not fields or fields.get('enabled', 'yes').lower() == 'no': continue
            require(set(fields.get('types', '').split()) <= {'deb', 'deb-src'} and fields.get('types'),
                    'unsupported apt source type')
            require(fields.get('signed-by') == keyring and fields.get('trusted', 'no').lower() != 'yes',
                    'every apt source must use only the Ubuntu archive keyring')
            require(all(fields.get(key, 'no').lower() == 'no' for key in
                        ('allow-insecure', 'allow-weak', 'allow-downgrade-to-insecure')),
                    'insecure apt source overrides are refused')
            require(fields.get('uris') and all(uri_ok(x) for x in fields['uris'].split()),
                    'only official Ubuntu archive/security sources are allowed')
            require(fields.get('suites') and set(fields['suites'].split()) <= allowed_suites,
                    'only noble suites are allowed')
            active += 1
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('#'): continue
            match = re.fullmatch(r'(deb|deb-src)\s+\[([^]]+)\]\s+(\S+)\s+(\S+)\s+(.+)', line)
            require(match is not None, 'legacy apt sources must explicitly specify Signed-By')
            options = dict(item.split('=', 1) for item in shlex.split(match[2]) if '=' in item)
            require(options.get('signed-by') == keyring and options.get('trusted', 'no') != 'yes',
                    'every apt source must use only the Ubuntu archive keyring')
            require(all(options.get(key, 'no').lower() == 'no' for key in
                        ('allow-insecure', 'allow-weak', 'allow-downgrade-to-insecure')),
                    'insecure apt source overrides are refused')
            require(uri_ok(match[3]) and match[4] in allowed_suites, 'non-Ubuntu or non-noble apt source refused')
            active += 1
require(active > 0, 'no eligible signed Ubuntu apt source')
# Refuse known host-share/network filesystems, including inactive bind-mounted
# Docker sockets detected separately below. Absence is not a Host isolation proof.
mounts = subprocess.check_output(['findmnt', '-rn', '-o', 'FSTYPE'], text=True).splitlines()
denied = {'9p', 'virtiofs', 'drvfs', 'cifs', 'smb3', 'nfs', 'nfs4', 'vboxsf', 'fuse.vmhgfs-fuse'}
require(not (set(mounts) & denied), 'Host-share or network-mounted filesystem refused')
PY
}

assert_runner_absence() {
  python3 - "$1" "$RUNNER_USER" <<'PY'
import os, re, selectors, subprocess, sys, time
def check_getent_account_absence(returncode, stdout, stderr):
    return type(returncode) is int and returncode == 2 and stdout == '' and stderr == ''

def check_service_inventory_absence(returncode, stdout, stderr):
    if type(returncode) is not int or returncode != 0 or stderr != '': return False
    if not isinstance(stdout, str) or not stdout.strip(): return False
    if any((ord(char) < 32 and char not in '\t\n') or ord(char) > 126 for char in stdout): return False
    states = {'enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked',
              'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'bad'}
    presets = {'enabled', 'disabled', 'ignored', '-', 'n/a'}
    seen = set()
    for line in stdout.splitlines():
        if not line.strip(): continue
        if any((ord(char) < 32 and char != '\t') or ord(char) > 126 for char in line): return False
        fields = line.split()
        if len(fields) != 3: return False
        unit, state, preset = fields
        if not re.fullmatch(r'[A-Za-z0-9:_.@\\-]{1,247}\.service', unit): return False
        if state not in states or preset not in presets or unit in seen: return False
        if re.fullmatch(r'actions\.runner\..*\.service', unit): return False
        seen.add(unit)
    return bool(seen)

def bounded_read(command, stdout_limit):
    environment = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C', 'SYSTEMD_COLORS': '0', 'SYSTEMD_PAGER': 'cat'}
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    limits = {'stdout': stdout_limit, 'stderr': 4096}
    selector = selectors.DefaultSelector()
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        deadline = time.monotonic() + 10
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('absence inventory command timed out')
            for key, _ in selector.select(min(remaining, 0.2)):
                name = key.data
                chunk = os.read(key.fileobj.fileno(), min(4096, limits[name] - len(buffers[name]) + 1))
                if not chunk:
                    selector.unregister(key.fileobj); continue
                available = limits[name] - len(buffers[name])
                if len(chunk) > available: raise ValueError('absence inventory exceeded its output bound')
                buffers[name].extend(chunk)
        returncode = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        return returncode, buffers['stdout'].decode('utf-8', errors='replace'), buffers['stderr'].decode('utf-8', errors='replace')
    finally:
        selector.close()
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=1)
            process.stdout.close(); process.stderr.close()

try:
    if sys.argv[1] == 'prepare':
        # getent documents 2 as a missing key. Other failures are not absence.
        if not check_getent_account_absence(*bounded_read(['getent', 'passwd', sys.argv[2]], 4096)):
            raise ValueError('fresh runner account absence was not verified')
    elif sys.argv[1] != 'baseline':
        raise ValueError('unknown absence inspection mode')
    # A filtered zero-match list exits 1 on the pinned systemd version. Query
    # the complete inventory; empty output alone never proves absence.
    command = ['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', '--full']
    if not check_service_inventory_absence(*bounded_read(command, 65536)):
        raise ValueError('service inventory failed, was unparseable, or contains an Actions runner unit')
except Exception:
    # Never log unrelated unit/account names or unknown command diagnostics.
    raise SystemExit('Runner account/service absence could not be verified') from None
PY
}
validate_guest_and_apt

if [[ "$MODE" == prepare ]]; then
  [[ ! -e "$BASE_ROOT" && ! -L "$BASE_ROOT" ]] || die 'base path already exists; use a fresh guest.'
  [[ ! -e "$RUNNER_ROOT" && ! -L "$RUNNER_ROOT" ]] || die 'runner path already exists; use a fresh guest.'
  [[ ! -e "/home/$RUNNER_USER" && ! -L "/home/$RUNNER_USER" ]] || die 'runner home already exists.'
  assert_runner_absence prepare
  install -d -m 0755 "$BASE_ROOT"
  # An interrupted preparation intentionally leaves this marker. Never resume a
  # partially modified image as though it were a newly verified base.
  printf '%s\n' 'UNQUALIFIED: preparation in progress' > "$BASE_ROOT/preparation-started"
  APT_OPTIONS=(-o Acquire::AllowInsecureRepositories=false
    -o Acquire::AllowDowngradeToInsecureRepositories=false
    -o APT::Get::AllowUnauthenticated=false)
  DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTIONS[@]}" update
  DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTIONS[@]}" install --yes --no-install-recommends "${PACKAGES[@]}"
  useradd --create-home --home-dir "/home/$RUNNER_USER" --shell /usr/sbin/nologin --user-group --no-log-init "$RUNNER_USER"
  passwd --lock "$RUNNER_USER" >/dev/null
  usermod --append --groups docker "$RUNNER_USER"
  install -d -m 0750 -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_ROOT"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --location --fail --silent --show-error \
    --retry 3 --connect-timeout 15 --max-time 300 \
    "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz" \
    --output "$ARCHIVE"
  printf '%s  %s\n' "$RUNNER_SHA256" "$ARCHIVE" | sha256sum --check --status || die 'Actions runner archive hash mismatch.'
  tar --extract --gzip --file "$ARCHIVE" --directory "$RUNNER_ROOT" --no-same-owner --no-same-permissions
  chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_ROOT"
  chmod 0750 "$RUNNER_ROOT"
  chmod 0400 "$ARCHIVE"
  systemctl enable --now docker.service >/dev/null
fi

assert_runner_absence baseline

# This code performs live, read-only validation in both modes. In check-only it
# never executes a runner binary, starts services, downloads, or rewrites files.
python3 - "$MODE" "$VERSION" "$RUNNER_USER" "$RUNNER_ROOT" "$MANIFEST" "$ARCHIVE" "$RUNNER_VERSION" "$RUNNER_SHA256" "$0" "${PACKAGES[@]}" <<'PY'
import datetime, grp, hashlib, json, os, pathlib, pwd, re, stat, subprocess, sys, tarfile
mode, version, user, root_name, manifest_name, archive_name, runner_version, archive_sha, script = sys.argv[1:10]
packages = sys.argv[10:]
root, manifest, archive = map(pathlib.Path, (root_name, manifest_name, archive_name))
checks = []
def require(ok, message):
    if not ok: raise SystemExit(message)
def checked(name): checks.append({'name': name, 'status': 'PASS'})
def digest(path):
    with open(path, 'rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()
def output(args): return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()
def check_sudo_denial(returncode, stdout, stderr, user):
    # sudo's list mode may exit 0 even for an explicit denial (observed on the
    # pinned Ubuntu image). Neither success nor failure status proves denial.
    # Accept only that target user's complete denial line and no stderr.
    if type(returncode) is not int or returncode not in (0, 1): return False
    if not isinstance(stdout, str) or stderr != '': return False
    return re.fullmatch(r'User ' + re.escape(user) +
                       r' is not allowed to run sudo on [A-Za-z0-9][A-Za-z0-9.-]{0,252}\.\n?', stdout) is not None
checked('ubuntu-24.04-amd64-hyper-v')
checked('signed-official-ubuntu-apt-sources')
checked('no-known-host-share-filesystem')
require(root.is_dir() and not root.is_symlink(), 'runner directory missing or is a symlink')
require(archive.is_file() and not archive.is_symlink() and archive.stat().st_uid == 0
        and stat.S_IMODE(archive.stat().st_mode) == 0o400 and digest(archive) == archive_sha,
        'runner archive missing, mode/ownership changed, or hash mismatch')
# Compare installed bytes to the pinned archive, not just to a self-reported
# manifest. Reject archive traversal and every unexplained extra runner file.
expected = set()
with tarfile.open(archive, 'r:gz') as bundle:
    for member in bundle:
        relative = pathlib.PurePosixPath(member.name)
        require(not relative.is_absolute() and '..' not in relative.parts, 'unsafe archive member')
        if str(relative) == '.': continue
        target = root.joinpath(*relative.parts)
        require(target.resolve().is_relative_to(root.resolve()), 'archive entry escapes runner directory')
        expected.add(str(relative))
        if member.isdir(): require(target.is_dir() and not target.is_symlink()
                                 and stat.S_IMODE(target.stat().st_mode) == member.mode & ~0o077,
                                 'runner archive directory changed')
        elif member.isfile():
            require(target.is_file() and not target.is_symlink()
                    and stat.S_IMODE(target.stat().st_mode) == member.mode & ~0o077, 'runner archive file changed')
            require(digest(target) == hashlib.file_digest(bundle.extractfile(member), 'sha256').hexdigest(), 'runner file bytes changed')
        elif member.issym(): require(target.is_symlink() and os.readlink(target) == member.linkname, 'runner symlink changed')
        else: raise SystemExit('unsupported runner archive entry')
actual = {str(path.relative_to(root)) for path in root.rglob('*')}
require(actual == expected, 'runner contains files outside its pinned archive (including registration state)')
checked('runner-pinned-archive-and-extracted-content')
account = pwd.getpwnam(user)
group_ids = os.getgrouplist(user, account.pw_gid)
groups = sorted(grp.getgrgid(gid).gr_name for gid in group_ids)
require(account.pw_uid >= 1000 and account.pw_uid != 0 and account.pw_dir == '/home/' + user
        and account.pw_shell == '/usr/sbin/nologin' and groups == sorted([user, 'docker']), 'unexpected runner identity or groups')
require(output(['passwd', '--status', user]).split()[1] == 'L', 'runner password is not locked')
for path in root.rglob('*'):
    require(path.lstat().st_uid == account.pw_uid and path.lstat().st_gid == account.pw_gid, 'runner content ownership changed')
require(root.stat().st_uid == account.pw_uid and stat.S_IMODE(root.stat().st_mode) == 0o750, 'runner root ownership/mode changed')
sudo = pathlib.Path('/usr/bin/sudo')
sudo_state = 'not-installed'
if sudo.exists():
    result = subprocess.run([str(sudo), '-n', '-l', '-U', user], capture_output=True, text=True,
                            env={**os.environ, 'LC_ALL': 'C'})
    require(check_sudo_denial(result.returncode, result.stdout, result.stderr, user),
            'runner has sudo rules, or sudo authorization could not be checked')
    sudo_state = 'no-authorized-commands'
checked('runner-locked-no-sudo-exact-groups')
for relative in ('.ssh', '.aws', '.azure', '.kube', '.config/gcloud', '.docker/config.json', '.git-credentials', '.netrc', '.npmrc'):
    target = pathlib.Path(account.pw_dir) / relative
    require(not target.exists() and not target.is_symlink(), 'unexpected runner credential/configuration path')
for process in ('Runner.Listener', 'Runner.Worker'):
    result = subprocess.run(['pgrep', '-x', process], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    require(result.returncode == 1, 'runner process exists or process inventory failed')
checked('runner-unregistered-no-service-no-process-no-credential-paths')
socket = pathlib.Path('/run/docker.sock')
require(stat.S_ISSOCK(socket.lstat().st_mode) and socket.lstat().st_uid == 0
        and socket.lstat().st_gid == grp.getgrnam('docker').gr_gid
        and stat.S_IMODE(socket.lstat().st_mode) == 0o660, 'unexpected guest Docker socket')
require(pathlib.Path('/var/run/docker.sock').resolve() == socket, 'Docker socket path changed')
require(output(['findmnt', '-rn', '-T', str(socket), '-o', 'TARGET']) != str(socket), 'bind-mounted Docker socket refused')
docker = json.loads(output(['docker', '--host', 'unix:///run/docker.sock', 'info', '--format', '{{json .}}']))
require(docker.get('OSType') == 'linux' and docker.get('DockerRootDir') == '/var/lib/docker', 'unexpected guest Docker daemon/root')
checked('guest-local-docker-socket-and-root')
installed = {}
for package in packages:
    state, package_version = output(['dpkg-query', '-W', '-f=${db:Status-Status}\t${Version}', package]).split('\t')
    require(state == 'installed', 'required guest package not installed')
    installed[package] = package_version
checked('required-dpkg-packages-installed')
script_sha = digest(script)
observation = {
    'schema': 'clued.production-vm-guest-base/1', 'initializer_version': version,
    'observed_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'state': 'nonproduction/unqualified', 'production_qualified': False, 'template_sealed': False,
    'runner_configured': False, 'script_provisioned_credentials': False,
    'guest': {'os': 'ubuntu', 'version': '24.04', 'architecture': 'amd64', 'virtualization': 'microsoft'},
    'runner': {'version': runner_version, 'archive_sha256': archive_sha, 'root': str(root),
               'uid': account.pw_uid, 'gid': account.pw_gid, 'groups': groups, 'sudo': sudo_state,
               'password_locked': True, 'job_started': False},
    'docker': {'socket': str(socket), 'root': docker['DockerRootDir'], 'version': docker['ServerVersion'],
               'privilege_boundary': 'guest-only; docker group can control this disposable guest'},
    'packages': installed, 'initializer_sha256': script_sha,
    'node_runtime': 'not-provisioned; workflow setup-node chooses its own version',
    'host_sealing_required': {
        'cloud_init_instance_data_present': pathlib.Path('/var/lib/cloud/instance').exists(),
        'root_authorized_keys_present': pathlib.Path('/root/.ssh/authorized_keys').exists(),
        'ssh_host_keys_present': any(pathlib.Path('/etc/ssh').glob('ssh_host_*_key')),
        'machine_id_present': pathlib.Path('/etc/machine-id').exists(),
        'note': 'Host must sanitize known initial-access/seed identity and bind stopped-disk evidence; this script deletes none'},
    'checks': checks,
}
if mode == 'prepare':
    require(not manifest.exists() and not manifest.is_symlink(), 'manifest already exists')
    with manifest.open('x') as stream: json.dump(observation, stream, indent=2); stream.write('\n')
    manifest.chmod(0o644)
else:
    require(manifest.is_file() and not manifest.is_symlink() and manifest.stat().st_uid == 0
            and stat.S_IMODE(manifest.stat().st_mode) == 0o644, 'base manifest missing or ownership/mode changed')
    original = json.loads(manifest.read_text())
    for key in ('schema', 'initializer_version', 'state', 'production_qualified', 'template_sealed', 'runner_configured',
                'script_provisioned_credentials', 'guest', 'runner', 'docker', 'packages', 'initializer_sha256', 'node_runtime'):
        require(original.get(key) == observation[key], 'live guest baseline differs from its prepared manifest: ' + key)
    observation['check_mode'] = 'read-only-live-verification'
    observation['manifest_sha256'] = digest(manifest)
print(json.dumps(observation, indent=2))
PY
