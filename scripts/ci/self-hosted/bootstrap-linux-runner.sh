#!/usr/bin/env bash
set -euo pipefail

SITE="home"
RUNNER_NAME=""
REPOSITORY_URL="https://github.com/tdoljyj/cross-memory-system"
ROOT="${HOME}/actions-runner"
RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
REPLACE=0

usage() {
  cat <<'EOF'
Usage:
  bootstrap-linux-runner.sh [--site home|company|other] [--name NAME]
                            [--root PATH] [--repository URL] [--replace]

The script expects a non-root Linux user with sudo, systemd, Git, curl,
tar, sha256sum, and a working native Docker Engine accessible to the user.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --site) SITE="$2"; shift 2 ;;
    --name) RUNNER_NAME="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --repository) REPOSITORY_URL="$2"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SITE" in home|company|other) ;; *) echo "Invalid site: $SITE" >&2; exit 2 ;; esac
[ -n "$RUNNER_NAME" ] || RUNNER_NAME="clued-ci-${SITE}-linux-01"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this bootstrap as the intended runner user, not root." >&2
  exit 1
fi

for command in git curl tar sha256sum systemctl sudo docker; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

[ "$(uname -s)" = "Linux" ] || { echo "Linux is required." >&2; exit 1; }
[ "$(uname -m)" = "x86_64" ] || { echo "x86_64 is required." >&2; exit 1; }
systemctl is-system-running >/dev/null 2>&1 || { echo "systemd is not running." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Native Docker Engine is not usable by $(whoami)." >&2; exit 1; }
id -nG | tr ' ' '\n' | grep -qx docker || { echo "Runner user must belong to the docker group." >&2; exit 1; }
sudo -v

mkdir -p "$ROOT"
if [ -f "$ROOT/.runner" ] && [ "$REPLACE" -ne 1 ]; then
  echo "Runner is already configured at $ROOT. Use --replace only for an intentional re-registration." >&2
  exit 1
fi

asset="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
url="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${asset}"
archive="$ROOT/$asset"

echo "Downloading GitHub Actions runner v$RUNNER_VERSION..."
curl -L --fail --retry 3 --connect-timeout 15 "$url" -o "$archive"
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$RUNNER_SHA256" ] || {
  echo "Runner SHA-256 mismatch. Expected $RUNNER_SHA256, got $actual" >&2
  exit 1
}

tar xzf "$archive" -C "$ROOT"
"$ROOT/bin/Runner.Listener" --version | grep -Fx "$RUNNER_VERSION" >/dev/null

printf 'Paste the one-time GitHub runner registration token: '
IFS= read -r -s token
printf '\n'
[ -n "$token" ] || { echo "Registration token was empty." >&2; exit 1; }

labels="clued,pool-general,trust-internal,site-${SITE},cap-docker-linux,runtime-wsl2"
args=(--unattended --url "$REPOSITORY_URL" --token "$token" --name "$RUNNER_NAME" --labels "$labels" --work _work)
[ "$REPLACE" -eq 1 ] && args+=(--replace)

(
  cd "$ROOT"
  ./config.sh "${args[@]}"
)
unset token

sudo "$ROOT/svc.sh" install "$(whoami)"
sudo "$ROOT/svc.sh" start
unit="$(systemctl list-unit-files 'actions.runner.*.service' --no-legend | awk -v n="$RUNNER_NAME" '$1 ~ n {print $1; exit}')"
[ -n "$unit" ] || { echo "Unable to resolve the installed runner service." >&2; exit 1; }
sudo systemctl is-enabled --quiet "$unit"
sudo systemctl is-active --quiet "$unit"

echo "Bootstrap complete."
echo "Runner: $RUNNER_NAME"
echo "Labels: $labels"
echo "Service: $unit"
echo "Docker: $(docker info --format 'Server={{.ServerVersion}} OS={{.OSType}} Driver={{.Driver}}')"
