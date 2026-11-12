# linux-sweep.sh - the one in-distribution sweep of the node governance task (Node Resource Governance Standard v1,
# classes 1-9 and the daily trim). The governance task (render.ps1) passes it base64-encoded through
# `wsl.exe -d <distribution> -u <account> -e bash -c ...`, so nothing has to be installed in the distribution.
#
#   linux-sweep.sh <class> <arguments...>       one class, the numbers from the standard (or the node's overrides)
#
# Rules (standard sections 1 and 7): only what is rebuildable or past its days; only below the roots it is given (or the
# account's own caches and temporary files); never through a link (-L is skipped, rm stays on one file system); nothing
# that a job may use while a Runner.Worker runs or when that cannot be told; at most MAXOBJ objects per call, the rest
# is reported as "debt <n>". Output, one fact per line: "deleted <MB> <path>", "debt <n>", "kept <reason>", "freed <MB>".
set -u -f
cls=${1:-}; [ $# -gt 0 ] && shift
freed=0
say() { printf '%s\n' "$*"; }
mb() { du -sm --one-file-system -- "$1" 2>/dev/null | cut -f1; }
# A job runs, or the process list cannot be read: two samples five seconds apart, like the governance task's own check.
busy() {
  local s
  for s in 1 2; do
    pgrep -f '[R]unner.Worker' >/dev/null; case $? in 0) return 0 ;; 1) ;; *) return 0 ;; esac
    [ "$s" = 1 ] && sleep "${SWEEP_SAMPLE_GAP:-5}"
  done
  return 1
}
remove() { # remove <path>: one object, never a link, never off its file system
  local p=$1 m
  [ -L "$p" ] && return 1
  m=$(mb "$p"); m=${m:-0}
  if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would delete $m $p"; else rm -rf --one-file-system -- "$p" 2>/dev/null || return 1; say "deleted $m $p"; fi
  freed=$((freed + m))
}
# candidates <days> <maxgb> <maxobj> < directories (one per line): oldest first, those past <days> go, then the oldest
# while the total is above <maxgb>; at most <maxobj>, the rest is debt.
candidates() {
  local days=$1 maxgb=$2 maxobj=$3 now total=0 n=0 left=0 t m p rows
  now=$(date +%s)
  rows=$(while IFS= read -r p; do [ -n "$p" ] && [ -d "$p" ] && [ ! -L "$p" ] && printf '%s %s %s\n' "$(stat -c %Y -- "$p")" "$(mb "$p")" "$p"; done | sort -n)
  [ -z "$rows" ] && return 0
  while read -r t m p; do total=$((total + m)); done <<EOF
$rows
EOF
  while read -r t m p; do
    if [ $((now - t)) -gt $((days * 86400)) ] || [ "$total" -gt $((maxgb * 1024)) ]; then
      if [ "$n" -ge "$maxobj" ]; then left=$((left + 1)); continue; fi
      remove "$p" && { n=$((n + 1)); total=$((total - m)); }
    fi
  done <<EOF
$rows
EOF
  [ "$left" -gt 0 ] && say "debt $left"
  return 0
}
need_idle() { if busy; then say "kept: a job is running or the processes cannot be read"; say "freed 0"; exit 0; fi; }

case "$cls" in
  runner_temp) # runner_temp <runner root>...: <root>/_work/_temp emptied
    need_idle
    for r in "$@"; do
      t=$r/_work/_temp
      { [ -d "$t" ] && [ ! -L "$t" ] && [ ! -L "$r/_work" ]; } || continue
      set +f; for p in "$t"/* "$t"/.[!.]*; do { [ -e "$p" ] || [ -L "$p" ]; } && { remove "$p" || true; }; done; set -f
    done ;;
  runner_checkout) # runner_checkout <days> <maxgb> <maxobj> <runner root>...: checkouts and downloaded actions
    days=$1 maxgb=$2 maxobj=$3; shift 3
    need_idle
    for r in "$@"; do
      [ -L "$r/_work" ] && continue
      set +f
      candidates "$days" "$maxgb" "$maxobj" < <(for p in "$r"/_work/* "$r"/_work/_actions/*; do case ${p##*/} in _temp|_tool|_actions|_diag|_PipelineMapping) ;; *) printf '%s\n' "$p" ;; esac; done)
      set -f
    done ;;
  runner_tool) # runner_tool <days> <maxgb> <maxobj> <runner root>...: tool cache versions
    days=$1 maxgb=$2 maxobj=$3; shift 3
    need_idle
    for r in "$@"; do
      { [ -L "$r/_work" ] || [ -L "$r/_work/_tool" ]; } && continue
      set +f
      candidates "$days" "$maxgb" "$maxobj" < <(for p in "$r"/_work/_tool/*/*; do printf '%s\n' "$p"; done)
      set -f
    done ;;
  docker_dangling) # docker_dangling <hours> <leftover container regex> <volume regex> <maxobj>
    hours=$1 cre=$2 vre=$3 maxobj=$4
    command -v docker >/dev/null || { say "kept: no docker"; say "freed 0"; exit 0; }
    need_idle
    if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would run docker image prune --force; docker container prune --force --filter until=${hours}h"
    else docker image prune --force >/dev/null 2>&1; docker container prune --force --filter "until=${hours}h" >/dev/null 2>&1; fi
    now=$(date +%s); n=0; left=0
    # Leftover stacks of finished jobs (supabase_*), running or not, older than <hours>; only while no job runs (above).
    while IFS='|' read -r name created; do
      printf '%s' "$name" | grep -Eq -- "$cre" || continue
      c=$(date -d "${created% [A-Z]*}" +%s 2>/dev/null) || continue
      [ $((now - c)) -gt $((hours * 3600)) ] || continue
      if [ "$n" -ge "$maxobj" ]; then left=$((left + 1)); continue; fi
      if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would delete 0 container:$name"; else docker rm -f "$name" >/dev/null 2>&1 && say "deleted 0 container:$name"; fi
      n=$((n + 1))
    done < <(docker ps -a --format '{{.Names}}|{{.CreatedAt}}' 2>/dev/null)
    # Volumes nothing references (docker refuses one in use), of the given names, older than <hours>.
    while IFS= read -r v; do
      printf '%s' "$v" | grep -Eq -- "$vre" || continue
      c=$(date -d "$(docker volume inspect -f '{{.CreatedAt}}' "$v" 2>/dev/null)" +%s 2>/dev/null) || continue
      [ $((now - c)) -gt $((hours * 3600)) ] || continue
      if [ "$n" -ge "$maxobj" ]; then left=$((left + 1)); continue; fi
      if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would delete 0 volume:$v"; else docker volume rm "$v" >/dev/null 2>&1 && say "deleted 0 volume:$v"; fi
      n=$((n + 1))
    done < <(docker volume ls -q -f dangling=true 2>/dev/null)
    [ "$left" -gt 0 ] && say "debt $left" ;;
  docker_images) # docker_images <days>: images no container uses, unused for <days>
    command -v docker >/dev/null || { say "kept: no docker"; say "freed 0"; exit 0; }
    need_idle
    if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would run docker image prune --all --force --filter until=$(( $1 * 24 ))h"
    else docker image prune --all --force --filter "until=$(( $1 * 24 ))h" 2>/dev/null | tail -1; fi ;;
  docker_build_cache) # docker_build_cache <days> <maxgb>
    command -v docker >/dev/null || { say "kept: no docker"; say "freed 0"; exit 0; }
    need_idle
    if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would run docker builder prune --force --filter until=$(( $1 * 24 ))h --keep-storage $2GB"
    else docker builder prune --force --filter "until=$(( $1 * 24 ))h" --keep-storage "$2GB" 2>/dev/null | tail -1; fi ;;
  package_caches) # package_caches <npm gb> <pip gb> <other gb>: a cache above its limit is emptied whole (rebuildable)
    npm=$1 pip=$2 other=$3
    need_idle
    for pair in "$HOME/.npm/_cacache:$npm" "$HOME/.cache/pip:$pip" "$HOME/.cache/ms-playwright:$other" "$HOME/.cache/yarn:$other" "$HOME/.cache/pnpm:$other"; do
      d=${pair%:*} lim=${pair##*:}
      { [ -d "$d" ] && [ ! -L "$d" ]; } || continue
      m=$(mb "$d"); [ "${m:-0}" -gt $((lim * 1024)) ] && remove "$d"
    done ;;
  temp) # temp <days> <maxobj>: this account's entries of /tmp untouched for <days>
    days=$1 maxobj=$2 n=0 left=0
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ "$n" -ge "$maxobj" ]; then left=$((left + 1)); continue; fi
      remove "$p" && n=$((n + 1))
    done < <(find "${SWEEP_TMP:-/tmp}" -mindepth 1 -maxdepth 1 -user "$(id -u)" -mtime +"$days" ! -type l 2>/dev/null)
    [ "$left" -gt 0 ] && say "debt $left" ;;
  scan_db) # scan_db <days> <maxgb>: trivy's layer cache past <days>, the whole cache above <maxgb> (it downloads again)
    d=$HOME/.cache/trivy
    { [ -d "$d" ] && [ ! -L "$d" ]; } || { say "freed 0"; exit 0; }
    need_idle
    if [ -d "$d/fanal" ] && [ -n "$(find "$d/fanal" -maxdepth 1 -mtime +"$1" -print -quit 2>/dev/null)" ]; then remove "$d/fanal"; fi
    m=$(mb "$d"); [ "${m:-0}" -gt $(($2 * 1024)) ] && remove "$d" ;;
  fstrim) # fstrim (root): what was freed goes back to the virtual disk's drive when it is sparse or compacted
    if [ -n "${SWEEP_DRY_RUN:-}" ]; then say "would run fstrim -v /"; else fstrim -v / 2>&1 | tail -1; fi ;;
  usage) # usage: the KB used on / (the governance task compares it with the virtual disk file)
    say "used_kb $(df -Pk / | awk 'NR==2 {print $3}')" ;;
  *) say "kept: unknown class $cls"; exit 2 ;;
esac
say "freed $freed"
