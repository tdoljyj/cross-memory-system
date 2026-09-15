"""Fixed pre-entry parent wiring candidate. No live authority transport attached.

Constraint checks are rejection checks only, never evidence of authorization.
No API, Docker, SQL or executable action is performed by this module.
"""
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re

BASE = Path(__file__).resolve().parent.parent / 'preentry-parent'
ROOT10_CONTRACT = Path(__file__).resolve().parent / 'Root10ControllerContract.candidate.json'
def load_exact(name, relative, digest):
    path = BASE.parent / relative
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Frozen dependency changed: ' + relative)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

v = load_exact('accepted_observation_validation', 'docker-engineering-observation/validation.py',
               '3ac10b11456ddc2de9155fb2b9f8f8c8c20ac0da51957e587d3081339767ac2e')
remote = load_exact('accepted_auxiliary_evidence', 'qualification-runtime/remote_evidence.py',
                    'a7373982ee405890fc7f260b96987d69d8133a0f5c318fc6e85c44d7fbb28969')
CHILD_SHA = '0217a6370c3d3756db3ac269da36d1e6f5d8dff2cf8d580c92e88ed0ef9708cb'
CHILD_PATH = Path(__file__).resolve().parent.parent / 'control-context-verifier-public-runtime-env-diagnostic-successor' / 'fixed_skill_fixture.py'
if hashlib.sha256(CHILD_PATH.read_bytes()).hexdigest() != CHILD_SHA:
    raise RuntimeError('Exact proposed fixture bytes changed')
_spec = importlib.util.spec_from_file_location('proposed_fixed_fixture', CHILD_PATH)
child = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(child)
PUBLIC_HOSTNAME = 'clued-synthetic-runtime'
PUBLIC_ENV = [key + '=' + value for key, value in child.PUBLIC_ENV.items()]
if PUBLIC_ENV[:5] != v.PUBLIC_ENV or len(PUBLIC_ENV) != 7:
    raise RuntimeError('Original image environment must remain the original five values')
DOCKER = '/usr/bin/docker'
# R17-F1. fixed_host.py used to gate on sys.platform=='win32' and on observe.py's DOCKER,
# which is still the Windows path -- so CREATE raised before anything ran. The binary
# identity moves here, beside the Linux path it belongs to, rather than into the shared
# docker-engineering-observation module, whose bytes the predecessor controllers pin.
DOCKER_SHA = '18c2a16d6aa0331bbd78b93e0a57f344c62bda0be52c054d4ee80e11176b0c30'
ENDPOINT = 'unix:///var/run/docker.sock'
# Literal fixed program: invokes the reviewed library primitive, not Skill text.
# No caller can supply code or arguments. This argv is review data, never run here.
PROGRAM = "import json,runpy,time,signal,sys; signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); print(json.dumps(runpy.run_path('/driver/fixed_skill_fixture.py',run_name='fixed_fixture_input')['isolated_action_primitive'](),sort_keys=True),flush=True); time.sleep(600)"
CMD = ['-I', '-S', '-B', '-c', PROGRAM]
LAYERS = ('account', 'integration_installation', 'context', 'binding')
STAGES = {'R05', 'R06', 'R07', 'R08', 'R09', 'R10'}


class Blocked(ValueError):
    pass


def require(value, reason):
    if not value:
        raise Blocked(reason)


def timestamp(value):
    require(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', value), 'invalid_timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def root10_window():
    """Read the manifest-pinned Root10 contract; unpublished/incomplete bytes refuse."""
    try:
        contract = json.loads(ROOT10_CONTRACT.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise Blocked('root10_contract_unavailable') from error
    require(contract.get('schema_version') == 'root10-single-window-controller-contract/1'
            and contract.get('ready') is True
            and type(contract.get('generation_id')) is str
            and re.fullmatch(r'ctrgen_[0-9a-f]{32}', contract['generation_id'])
            and contract.get('generation_ordinal') == 10
            and set(contract.get('window', {})) == {'not_before', 'expires_at'},
            'root10_contract_not_final')
    start, end = (timestamp(contract['window'][key]) for key in ('not_before', 'expires_at'))
    require(start < end, 'root10_contract_window_invalid')
    return start, end


def effective_window(ga_raw, temporal=None):
    """Check the exact separately verified supplement; never rewrite GA bytes.

    Owner signature and authentic DB event checks belong to the trusted parent
    entry. This fixed host additionally rejects mismatched raw data or clocks.
    """
    ga = json.loads(ga_raw)
    if temporal is None:
        return tuple(timestamp(ga[key]) for key in ('issued_at', 'deadline', 'expires_at'))
    require(type(temporal) is dict and set(temporal) == {'raw', 'sha256', 'event'}, 'exact_temporal_host_fields')
    ga_sha = hashlib.sha256(ga_raw.encode('utf-8')).hexdigest()
    expected_ga = '68afb1e6dc1367729cd6864b9ba9b5d846ab123ff5539d7a646f7fa1df988f78'
    expected_amendment = '38eb6adca66de464fa88f4b7333649e9555d6a7d6b3fc23cd20ac18a0cfec4a6'
    require(ga_sha == expected_ga and ga.get('gate_authorization_id') == 'ga_32daa5daf52c4deb8e893c25b08eff38', 'exact_temporal_original_ga')
    require(type(temporal['raw']) is str and temporal['sha256'] == expected_amendment
            and hashlib.sha256(temporal['raw'].encode('utf-8')).hexdigest() == expected_amendment, 'exact_temporal_amendment_bytes')
    amendment = json.loads(temporal['raw'])
    event = temporal['event']
    require(type(event) is dict and event.get('sequence') == 118, 'exact_temporal_activation_event')
    request = event.get('request', {})
    key = 'root10_same_ga_temporal_continuation_20260915'
    require(set(request) == {'operation', 'ga_id', 'expected_sequence', 'idempotency_key', 'body'}
            and request['operation'] == 'TEMPORAL_CONTINUATION_ACTIVATED' and request['expected_sequence'] == 117
            and request['idempotency_key'] == key and event.get('idempotency_key') == key
            and request['ga_id'] == ga['gate_authorization_id'], 'exact_temporal_activation_binding')
    body = request['body']
    require(type(body) is dict and set(body) == {'activated_at', 'amendment_ref', 'amendment_sha256', 'automatic_retry',
            'budget_raw_sha256', 'budget_refund', 'budget_sequence', 'effect_deadline', 'finalization_expires_at',
            'new_binding', 'new_binding_sha256', 'new_budget', 'new_ga', 'old_binding', 'old_binding_sha256', 'prior_ga_sha256'}, 'exact_temporal_event_body')
    require(body['prior_ga_sha256'] == ga_sha and body['amendment_sha256'] == expected_amendment
            and body['amendment_ref'].get('sha256') == expected_amendment
            and body['budget_sequence'] == 117 and body['budget_raw_sha256'] == ga['budget_reservation_ref']['sha256']
            and all(body[key] is False for key in ('automatic_retry', 'budget_refund', 'new_budget', 'new_ga')), 'exact_temporal_nonexpanding_binding')
    require(event.get('root_id') == amendment['root_id'] and ga['control_trust_root_generation'] == amendment['control_trust_root_generation']
            and ga['deadline'] == ga['expires_at'] == amendment['ga_ref']['original_deadline'], 'original_temporal_identity_and_clock_immutable')
    issued, deadline, expires = (timestamp(body[key]) for key in ('activated_at', 'effect_deadline', 'finalization_expires_at'))
    owner_start, owner_end = root10_window()
    require(owner_start <= issued and timestamp(ga['deadline']) < issued and (deadline-issued).total_seconds() == 600
            and deadline <= expires == owner_end, 'exact_temporal_effect_and_finalization_window')
    return issued, deadline, expires


def reject_constraints(ga, profile, now):
    """Original GA/Profile semantic rejection checks; no signature/acceptance."""
    require(type(ga) is dict and type(profile) is dict, 'missing_ga_profile')
    require(ga.get('authorization_status') == 'AUTHORIZED' and ga.get('environment') == 'ISOLATED_TEST'
            and ga.get('purpose') == 'SKILL_COEXISTENCE_QUALIFICATION', 'wrong_phase_or_purpose')
    require(profile.get('profile_id') == 'DP-PREENTRY-SKILL-QUALIFICATION', 'wrong_profile')
    require(type(profile.get('required_stages')) is list and set(profile['required_stages']) == STAGES
            and len(profile['required_stages']) == 6, 'required_stage_definition_changed')
    require(profile.get('candidate_must_differ_from_controller') is True, 'controller_independence_missing')
    require(ga.get('candidate_skill_digest') != ga.get('controller_digest')
            and all(type(ga.get(k)) is str and re.fullmatch('[0-9a-f]{64}', ga[k])
                    for k in ('candidate_skill_digest', 'controller_digest')), 'circular_subject')
    issued, expires, deadline = (timestamp(ga.get(k)) for k in ('issued_at', 'expires_at', 'deadline'))
    require(isinstance(now, datetime) and now.tzinfo is not None, 'trusted_clock_missing')
    limit = profile.get('max_lifetime_seconds')
    require(type(limit) is int and 0 < limit <= 600, 'invalid_profile_lifetime')
    require(issued <= now < deadline <= expires and 0 < (expires-issued).total_seconds() <= limit, 'expired_or_unbounded_ga')
    owner_start, owner_end = root10_window()
    require(owner_start <= issued and expires <= owner_end, 'owner_window_exceeded')
    for key in ('control_trust_root_generation', 'runner_generation', 'credential_generation', 'session_generation'):
        require(type(ga.get(key)) is str and ga[key].strip() and ga[key] != 'not_applicable', 'missing_independent_generation_' + key)
    vector = ga.get('revocation_epoch_vector')
    require(type(vector) is dict and type(vector.get('vector_schema_version')) is str
            and vector['vector_schema_version'].strip(), 'missing_vector')
    for layer in LAYERS:
        scope, epoch = vector.get(layer + '_scope_ref'), vector.get(layer + '_epoch')
        if scope == 'not_applicable' or epoch == 'not_applicable':
            require(scope == epoch == 'not_applicable', 'unpaired_na_' + layer)
            permission = profile.get('not_applicable_layer_permissions', {}).get(layer)
            evidence = vector.get('not_applicable_evidence', {}).get(layer)
            require(type(permission) is dict and type(evidence) is dict and permission == evidence,
                    'missing_exact_na_permission_' + layer)
            require(type(permission.get('reason')) is str and permission['reason'].strip()
                    and type(permission.get('accepted_schema_ref')) is dict, 'na_schema_unresolved_' + layer)
        else:
            require(type(scope) is str and scope.strip() and type(epoch) is int
                    and 0 <= epoch <= 9007199254740991, 'invalid_business_epoch_' + layer)
    # Passing these checks has no authority effect. Resolve accepted Schema,
    # signed Profile/GA/root, all refs/current epochs and reservations separately.


def admission(ga, profile, now):
    try:
        reject_constraints(ga, profile, now)
        # Real root registration is being supplied by the existing protocol;
        # do not invent a read_root shape/signature verifier or accept booleans.
        raise Blocked('live_root_profile_ga_signature_current_vector_budget_adapter_not_connected')
    except (Blocked, ValueError, TypeError, AttributeError) as error:
        return {'status': 'BLOCKED', 'reason': str(error), 'side_effects_dispatched': 0,
                'authorization_effect': 'NONE', 'qualified': False}


def paths(nonce):
    v.model.config({'image': v.IMAGE, 'run_key': nonce})
    folder = BASE / 'work' / nonce
    for item in (folder, *folder.parents):
        v.model.unlinked(item)
    return folder, folder / 'driver', folder / 'allowed'


def fixed_argv(nonce, operation, identity=None):
    folder, driver, allowed = paths(nonce)
    prefix = [DOCKER, '--host=' + ENDPOINT, '--config=' + (folder / 'docker-config').as_posix()]
    if operation != 'create':
        return prefix + v.model.fixed_argv(operation, identity)[1:]
    require(identity is None, 'create_cannot_reuse_container_identity')
    args = v.model.create_argv({'image': v.IMAGE, 'run_key': nonce})[1:]
    old_driver, old_allowed = v.model.paths({'image': v.IMAGE, 'run_key': nonce})
    args = [part.replace('source=' + old_driver + ',target=/driver/probe.py', 'source=' + driver.as_posix() + ',target=/driver')
            .replace('source=' + old_allowed + ',', 'source=' + allowed.as_posix() + ',') for part in args]
    args = args[:-4] + CMD
    image_at = args.index(v.IMAGE)
    # Seven explicit literal --env values prevent host-name-only inheritance.
    args[image_at:image_at] = ['--hostname=' + PUBLIC_HOSTNAME] + ['--env=' + item for item in PUBLIC_ENV]
    return prefix + args


def exact_public_environment(value):
    """Exactly the seven fixed public key/value strings; Docker order is immaterial."""
    return (type(value) is list and len(value) == len(PUBLIC_ENV) == 7
            and all(type(item) is str for item in value)
            and len({item.split('=', 1)[0] for item in value}) == 7
            and set(value) == set(PUBLIC_ENV))


def prestart(inspected, nonce, identity):
    """Exact fixed successor mounts/command before reuse of frozen validators."""
    try:
        _, driver, allowed = paths(nonce)
        value = copy.deepcopy(inspected)
        require(value.get('Image') == v.IMAGE_DIGEST and value.get('Name') == '/clued-synthetic-' + nonce
                and value['Config'].get('Labels', {}).get('clued.scope') == 'synthetic-engineering-only', 'wrong_owned_subject')
        require(value['Config']['Cmd'] == CMD and exact_public_environment(value['Config']['Env'])
                and value['Config'].get('Hostname') == PUBLIC_HOSTNAME
                and value['Config'].get('Tty') is False, 'wrong_fixed_program_or_env')
        mounts = value['Mounts']
        require(type(mounts) is list and len(mounts) == 2, 'unexpected_mount_count')
        for mount in mounts:
            if mount.get('Destination') == '/driver':
                require(v.source_matches(mount.get('Source'), driver) and mount.get('RW') is False, 'driver_mount_changed')
                mount['Destination'] = '/driver/probe.py'
            else:
                require(mount.get('Destination') == '/allowed' and v.source_matches(mount.get('Source'), allowed), 'unexpected_mount')
        value['Config']['Cmd'] = ['-I', '-S', '-B', '/driver/probe.py']
        value['Config']['Env'] = []
        expected = v.model.paths({'image': v.IMAGE, 'run_key': nonce})
        for mount in mounts:
            mount['Source'] = expected[0 if mount['Destination'] == '/driver/probe.py' else 1]
        return v.model.prestart({'image': v.IMAGE, 'run_key': nonce}, identity, value)
    except (Blocked, KeyError, TypeError, ValueError):
        return False


def intent_before_action(api, intent_ref, raw, ga, profile, now):
    """Existing remote byte verifier connected behind closed authority gate.

When real admission is connected, remote exact-byte read-back must occur between
two fresh authority checks. No callback or accepted=True bypass is exposed.
"""
    first = admission(ga, profile, now)
    if first['status'] != 'AUTHORIZED':
        return first
    remote.read_back(api, intent_ref, raw)
    return admission(ga, profile, datetime.now(timezone.utc))


if __name__ == '__main__':
    print(json.dumps(admission(None, None, datetime.now(timezone.utc))))
