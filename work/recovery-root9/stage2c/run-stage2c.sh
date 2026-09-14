#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
MODE=dry-run
CONFIRMATION=
EVIDENCE=
EVIDENCE_SHA256=
M4_COMMIT=
APPLY_SQL="$SCRIPT_DIR/root9_apply_once.sealed.sql"
OUTPUT_DIR=
WINDOW_NOT_BEFORE=2026-09-14T03:00:00Z
WINDOW_EXPIRES=2026-09-15T03:00:00Z
EXPECTED_M3=9398c6cb8db84b802facebf683c134fb1ba4ad5d
EXPECTED_APPLY_SHA256=f3f58366a06411d9578a29baf226543760027d0bfef3b33261b08161d394eeb1

usage() {
  printf '%s\n' \
    'Default: offline dry-run; makes no database connection and needs no credential.' \
    'Usage:' \
    '  run-stage2c.sh [--dry-run] [--evidence FILE --evidence-sha256 HEX --m4-commit HEX]' \
    '  run-stage2c.sh --apply-once ROOT9_STAGE2C_CAS_REPOINT_ONCE \' \
    '    --evidence FILE --evidence-sha256 HEX --m4-commit HEX \' \
    '    [--apply-sql FILE] [--output-dir DIR]' \
    '' \
    'Apply mode additionally requires DATABASE_URL in the environment. The URL is never printed.'
}

while (($#)); do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --apply-once) MODE=apply; CONFIRMATION=${2-}; shift 2 ;;
    --evidence) EVIDENCE=${2-}; shift 2 ;;
    --evidence-sha256) EVIDENCE_SHA256=${2-}; shift 2 ;;
    --m4-commit) M4_COMMIT=${2-}; shift 2 ;;
    --apply-sql) APPLY_SQL=${2-}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'REFUSED_UNKNOWN_ARGUMENT=%s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

command -v python3 >/dev/null || { printf '%s\n' 'REFUSED_PYTHON3_REQUIRED' >&2; exit 69; }

# This validates every path and byte described by post-M4 evidence against the
# local M4 directory. The M4 SHA is supplied only after merge; it is not baked in.
validate_evidence() {
  python3 - "$EVIDENCE" "$EVIDENCE_SHA256" "$M4_COMMIT" "$EXPECTED_M3" "$SCRIPT_DIR" "$APPLY_SQL" "$EXPECTED_APPLY_SHA256" <<'PY'
import hashlib,json,os,re,sys
epath, expected_ehash, cli_m4, m3, script_dir, apply_sql, expected_apply_sha = sys.argv[1:]
def die(msg):
    print('REFUSED_M4_EVIDENCE_'+msg, file=sys.stderr); raise SystemExit(65)
if not epath or not os.path.isfile(epath): die('FILE_REQUIRED')
if not re.fullmatch(r'[0-9a-f]{64}',expected_ehash or ''): die('SHA256_REQUIRED')
raw=open(epath,'rb').read()
if hashlib.sha256(raw).hexdigest()!=expected_ehash: die('FILE_SHA_MISMATCH')
try: e=json.loads(raw)
except Exception: die('INVALID_JSON')
if e.get('object_type')!='Stage2COwnerMergeEvidence' or e.get('state')!='VERIFIED_STAGE2C_OWNER_MERGE': die('STATE')
if e.get('authority_effect')!='NONE' or e.get('repository')!='tdoljyj/cross-memory-system': die('SCOPE')
m=e.get('merge') or {}
if not re.fullmatch(r'[0-9a-f]{40}',cli_m4 or '') or m.get('sha')!=cli_m4: die('M4_SHA')
parents=m.get('parents')
if not isinstance(parents,list) or len(parents)!=2 or parents[0]!=m3: die('TOPOLOGY')
if m.get('first_parent')!=m3 or m.get('source_parent')!=parents[1] or parents[1]==m3: die('PARENTS')
if not re.fullmatch(r'[0-9a-f]{40}',m.get('tree','')) or not re.fullmatch(r'[0-9a-f]{40}',parents[1]): die('GIT_IDS')
if m.get('author_login')!='tdoljyj' or m.get('merged_by')!='tdoljyj' or m.get('committer_login')!='web-flow': die('OWNER_WEB_FLOW')
if m.get('base_ref')!='main' or m.get('pull_request_count')!=1: die('UNIQUE_MAIN_PR')
if not isinstance(m.get('pull_request'),int) or m.get('pull_request')!=e.get('pull_request'): die('PR_NUMBER')
v=m.get('verification') or {}
if v.get('verified') is not True or v.get('reason')!='valid': die('SIGNATURE')
if m.get('exact_merged_pr') is not True: die('EXACT_PR')
arts=e.get('artifacts')
if not isinstance(arts,list) or not arts or e.get('exact_files_verified')!=len(arts): die('ARTIFACT_COUNT')
paths=[a.get('path') for a in arts]
if any(not isinstance(p,str) for p in paths) or len(paths)!=len(set(paths)): die('DUPLICATE_PATH')
path_digest=hashlib.sha256(''.join(p+'\n' for p in sorted(paths)).encode()).hexdigest()
if e.get('path_set_sha256')!=path_digest: die('PATH_SET_DIGEST')
prefix='work/recovery-root9/stage2c/'
required={prefix+x for x in ('preflight.sql','post-readback.sql','run-stage2c.sh','dependency-graph.json','final-contract.json','root9_apply_once.sealed.sql')}
if not required.issubset(paths): die('REQUIRED_PATH_MISSING')
by_path={a['path']:a for a in arts}
for a in arts:
    p=a['path']
    if not p.startswith(prefix): die('PATH_OUTSIDE_STAGE2C')
    rel=p[len(prefix):]
    if not rel or '/' in rel or rel in ('.','..'): die('NONFLAT_OR_TRAVERSAL_PATH')
    if a.get('change_status')!='added': die('NON_APPEND_ONLY_PUBLICATION')
    if not re.fullmatch(r'[0-9a-f]{40}',a.get('blob_sha','')): die('BLOB_SHA')
    if not re.fullmatch(r'[0-9a-f]{64}',a.get('sha256','')) or not isinstance(a.get('bytes'),int): die('FILE_METADATA')
    local=os.path.join(script_dir,rel)
    if not os.path.isfile(local): die('LOCAL_FILE_MISSING_'+rel)
    b=open(local,'rb').read()
    if len(b)!=a['bytes'] or hashlib.sha256(b).hexdigest()!=a['sha256']: die('LOCAL_FILE_MISMATCH_'+rel)
expected_apply=os.path.realpath(os.path.join(script_dir,'root9_apply_once.sealed.sql'))
if os.path.realpath(apply_sql)!=expected_apply: die('APPLY_SQL_PATH')
actual_apply_sha=hashlib.sha256(open(apply_sql,'rb').read()).hexdigest()
if expected_apply_sha!='f3f58366a06411d9578a29baf226543760027d0bfef3b33261b08161d394eeb1': die('INTERNAL_APPLY_PIN')
if actual_apply_sha!=expected_apply_sha or by_path[prefix+'root9_apply_once.sealed.sql']['sha256']!=expected_apply_sha: die('APPLY_SQL_HASH')
safety=e.get('safety_boundary') or {}
for key,want in {'history_rewrite':False,'capacity_value_change':False,'refund':False,'budget_reservations':0,'ga_dispatches':0}.items():
    if safety.get(key)!=want: die('SAFETY_'+key.upper())
print(json.dumps({'state':'PASS_VERIFIED_STAGE2C_OWNER_MERGE','m4':cli_m4,'tree':m['tree'],'files':len(arts),'path_set_sha256':path_digest},separators=(',',':')))
PY
}

static_dry_run() {
  python3 - "$SCRIPT_DIR" <<'PY'
import json,os,re,sys
d=sys.argv[1]
for f in ('dependency-graph.json','final-contract.json'):
    with open(os.path.join(d,f),'rb') as h: json.load(h)
pre=open(os.path.join(d,'preflight.sql'),encoding='utf-8').read()
post=open(os.path.join(d,'post-readback.sql'),encoding='utf-8').read()
both=pre+'\n'+post
required=['begin transaction read only','9398c6cb8db84b802facebf683c134fb1ba4ad5d','ctrgen_b060bc520329398936e461af6a477f94','ctrgen_308a1dfc185cff633892638581e0a34c','d0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8','no_seq102','routine_acl_sha256']
if any(x not in both for x in required): raise SystemExit('REFUSED_STATIC_CONTRACT_MISSING')
for forbidden in ('insert into clued_control.gate_attempts','update clued_control.events','update clued_control.execution_events','delete from clued_control'):
    if forbidden.lower() in both.lower(): raise SystemExit('REFUSED_READONLY_SQL_MUTATION_TOKEN_'+forbidden)
contract=json.load(open(os.path.join(d,'final-contract.json'),encoding='utf-8'))
if contract['future_m4']['commit'] is not None or contract['future_m4']['tree'] is not None: raise SystemExit('REFUSED_FUTURE_M4_PREBOUND')
print('{"state":"PASS_DRY_RUN_NO_DATABASE_CONTACT","database_contact":false,"credentials_required":false}')
PY
}

static_dry_run
if [[ -n "$EVIDENCE" || -n "$EVIDENCE_SHA256" || -n "$M4_COMMIT" ]]; then
  [[ -n "$EVIDENCE" && -n "$EVIDENCE_SHA256" && -n "$M4_COMMIT" ]] || { printf '%s\n' 'REFUSED_INCOMPLETE_M4_EVIDENCE_ARGUMENTS' >&2; exit 65; }
  validate_evidence
fi

if [[ "$MODE" == dry-run ]]; then
  printf '%s\n' '{"state":"DRY_RUN_COMPLETE_NO_DATABASE_CONTACT","apply_attempted":false}'
  exit 0
fi

[[ "$CONFIRMATION" == ROOT9_STAGE2C_CAS_REPOINT_ONCE ]] || { printf '%s\n' 'REFUSED_EXACT_APPLY_CONFIRMATION_REQUIRED' >&2; exit 64; }
[[ -n "$EVIDENCE" && -n "$EVIDENCE_SHA256" && -n "$M4_COMMIT" ]] || { printf '%s\n' 'REFUSED_VERIFIED_M4_EVIDENCE_REQUIRED' >&2; exit 65; }
[[ -f "$APPLY_SQL" ]] || { printf '%s\n' 'REFUSED_EXACT_APPLY_SQL_REQUIRED' >&2; exit 66; }
[[ -n "${DATABASE_URL-}" ]] || { printf '%s\n' 'REFUSED_DATABASE_URL_REQUIRED_ONLY_FOR_APPLY' >&2; exit 67; }
command -v psql >/dev/null || { printf '%s\n' 'REFUSED_PSQL_REQUIRED' >&2; exit 69; }
validate_evidence

python3 - "$WINDOW_NOT_BEFORE" "$WINDOW_EXPIRES" <<'PY'
from datetime import datetime,timezone
import sys
nb=datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
ex=datetime.fromisoformat(sys.argv[2].replace('Z','+00:00'))
now=datetime.now(timezone.utc)
if not nb <= now < ex:
    print('REFUSED_OUTSIDE_ROOT9_WINDOW',file=sys.stderr); raise SystemExit(68)
print('{"state":"PASS_LOCAL_UTC_WINDOW","now":"'+now.isoformat()+'"}')
PY

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$PWD/stage2c-run-$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p -- "$OUTPUT_DIR"
PRE="$OUTPUT_DIR/preflight.json"
APPLY_OUT="$OUTPUT_DIR/apply.stdout"
APPLY_ERR="$OUTPUT_DIR/apply.stderr"
POST="$OUTPUT_DIR/post-readback.json"

READONLY_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000'
PGCONNECT_TIMEOUT=15 PGOPTIONS="$READONLY_OPTIONS" psql "$DATABASE_URL" --no-password -X -qAt -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/preflight.sql" >"$PRE"
python3 - "$PRE" <<'PY'
import json,sys
try: x=json.load(open(sys.argv[1]))
except Exception: raise SystemExit('REFUSED_PREFLIGHT_NOT_SINGLE_JSON')
if x.get('all_pass') is not True or x.get('state')!='PASS_EXACT_ROOT8_SEQ97_PREIMAGE':
    raise SystemExit('REFUSED_PREFLIGHT_NOT_ALL_GREEN')
print('{"state":"PASS_LIVE_READ_ONLY_PREFLIGHT"}')
PY

# Exactly one call. Never loop or retry this command. The SQL embeds the exact
# request bytes; no request material or credential is passed on the command line.
set +e
PGCONNECT_TIMEOUT=15 psql "$DATABASE_URL" --no-password -X -qAt -v ON_ERROR_STOP=1 -f "$APPLY_SQL" >"$APPLY_OUT" 2>"$APPLY_ERR"
APPLY_RC=$?
set -e

# Read back once whether the client reported success or failure. A non-zero apply
# exit is UNKNOWN, never permission to resend.
set +e
PGCONNECT_TIMEOUT=15 PGOPTIONS="$READONLY_OPTIONS" psql "$DATABASE_URL" --no-password -X -qAt -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/post-readback.sql" >"$POST"
POST_RC=$?
set -e

if ((POST_RC != 0)); then
  printf '{"state":"UNKNOWN_READBACK_FAILED","apply_exit":%d,"automatic_retry":false}\n' "$APPLY_RC" >&2
  exit 75
fi

python3 - "$PRE" "$POST" "$APPLY_RC" <<'PY'
import json,sys
pre=json.load(open(sys.argv[1])); post=json.load(open(sys.argv[2])); apply_rc=int(sys.argv[3])
if post.get('all_pass') is not True or post.get('state')!='PASS_EXACT_ROOT9_SEQ101_POSTIMAGE':
    raise SystemExit('UNKNOWN_OR_REJECTED_POSTIMAGE_NEVER_RETRY')
if pre.get('snapshot') != post.get('snapshot'):
    a=pre.get('snapshot',{}); b=post.get('snapshot',{})
    drift=sorted(k for k in set(a)|set(b) if a.get(k)!=b.get(k))
    raise SystemExit('REFUSED_PRESERVATION_OR_ACL_DRIFT_'+','.join(drift))
state='PASS_APPLIED_AND_INDEPENDENT_READBACK' if apply_rc==0 else 'POSTIMAGE_PRESENT_AFTER_APPLY_CLIENT_ERROR_NEVER_RETRY'
print(json.dumps({'state':state,'apply_exit':apply_rc,'root_sequence':9,'execution_sequence':101,'seq102_created':False,'budget_reservations':0,'automatic_retry':False},separators=(',',':')))
PY
