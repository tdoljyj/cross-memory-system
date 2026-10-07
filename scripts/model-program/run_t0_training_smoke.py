"""Tiny T0 CPU training recipe candidate. Default is plan-only.

Local checks bind bytes and bounds; they are NOT a Gate or authority issuer.
An external trusted Host must verify the real issued Profile, Owner, claim,
data/device permissions and window before allowing the exact --execute command.
No model API, downloads, network, subprocess, GPU, native API or installs.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time
import uuid

TASK_ID = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a'
RECIPE_ID = 'T0-CPU-SYNTHETIC-BIGRAM-v0.1'
CORPUS = 'abacabadabacabad'
VOCABULARY = ['a', 'b', 'c', 'd']
REPO = Path(__file__).absolute().parents[2]
RECIPE_PATH = REPO / 'development/contracts/model-program/stage-admission/T0TrainingRecipe.v0.1.json'
OUTPUT_ROOT = REPO / 'work/model-program/t0-training-smoke'
MAX_BYTES = 1048576
# No accepted issued Profile / trusted execution entry is installed by this candidate.
# A JSON file or CLI switch can never turn this into a trusted Host verifier.
HOST_EXECUTION_BRIDGE_AVAILABLE = False

class PreflightError(ValueError):
    pass

class TrainingStopped(RuntimeError):
    pass

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def validate_recipe(recipe):
    required = {'recipe_id': RECIPE_ID, 'task_id': TASK_ID,
                'dataset_parent_boundary': 'TRAINING', 'dataset_purpose_id': 'training',
                'corpus': CORPUS, 'vocabulary': VOCABULARY,
                'parameter_count': 16, 'control_steps': 8,
                'checkpoint_steps': 4, 'resume_steps': 4,
                'total_sgd_updates': 16, 'attempts': 1,
                'cooperative_wall_seconds': 30, 'host_hard_timeout_seconds': 120,
                'max_artifact_bytes': MAX_BYTES, 'learning_rate': 0.25}
    if not isinstance(recipe, dict):
        raise PreflightError('RECIPE_OBJECT_REQUIRED')
    allowed = set(required) | {'schema_version', 'status', 'qualification', 'authority_effect',
        'data_kind', 'corpus_sha256', 'model', 'initialization', 'optimizer', 'runner_path',
        'runner_sha256', 'dependency', 'checkpoint', 'output_scope', 'collision_or_failure',
        'evidence', 'prohibited', 'missing_before_execution', 'local_cli_or_profile_fields_are_authority',
        'current_models_or_training_executed', 'compute_scope'}
    if set(recipe) - allowed:
        raise PreflightError('UNKNOWN_RECIPE_FIELDS')
    for key, value in required.items():
        if type(recipe.get(key)) is not type(value) or recipe[key] != value:
            raise PreflightError('RECIPE_MISMATCH_' + key)
    expected_compute = {'optimizer_updates': 16, 'loss_evaluations': 17,
                        'full_batch_compute_passes': 33, 'training_pairs': 15,
                        'softmax_pair_evaluations': 495, 'max_scalar_exp_evaluations': 1980,
                        'external_model_or_provider_calls': 0, 'zero_compute_claim': False}
    compute = recipe.get('compute_scope')
    if not isinstance(compute, dict) or set(compute) != set(expected_compute):
        raise PreflightError('EXACT_COMPUTE_SCOPE_REQUIRED')
    for key, value in expected_compute.items():
        if type(compute[key]) is not type(value) or compute[key] != value:
            raise PreflightError('COMPUTE_SCOPE_MISMATCH_' + key)
    if recipe.get('corpus_sha256') != digest(CORPUS.encode('ascii')):
        raise PreflightError('CORPUS_HASH_MISMATCH')
    return recipe

def build_plan(recipe=None, profile=None):
    if recipe is not None:
        validate_recipe(recipe)
    return {'schema': 'clued.t0-training-smoke-plan/1', 'recipe_id': RECIPE_ID,
            'task_id': TASK_ID, 'actual_execution': 'NONE', 'authority_effect': 'NONE',
            'qualification': 'NOT_ISSUED', 'total_sgd_updates': 16,
            'trajectories': {'control': 8, 'checkpoint_segment': 4, 'resume_segment': 4},
            'parameter_count': 16, 'initial_weights': '4x4 exact zeros; not initialized by this plan',
            'loss_evaluations': 17, 'full_batch_compute_passes': 33, 'softmax_pair_evaluations': 495,
            'external_model_or_provider_calls': 0,
            'dataset_parent_boundary': 'TRAINING', 'dataset_purpose_id': 'training',
            'corpus_sha256': digest(CORPUS.encode('ascii')),
            'attempts': 1, 'cooperative_wall_seconds': 30, 'host_hard_timeout_seconds': 120,
            'max_artifact_bytes': MAX_BYTES, 'output_root': str(OUTPUT_ROOT),
            'profile_present': profile is not None, 'execution_ready': False,
            'blocking_fields': ['Actual issued exact Profile', 'External Host current Owner/claim/data/device/window verification', 'Trusted execution entry not implemented in this candidate'],
            'conclusion_scope': 'Pipeline, checkpoint and deterministic resume engineering only; no M2/M3 or model-quality PASS'}

def preflight_execute(recipe, profile, host_verified_state, *, runner_sha256,
                      recipe_sha256, output_exists=False):
    """Pure policy/integrity checks. No FS or forward/SGD. Not admission.
    host_verified_state is recorded launch context, not a forged JSON capability.
    The external Host must authorize launch independently of these caller fields.
    """
    validate_recipe(recipe)
    if output_exists:
        raise PreflightError('ATTEMPT_OR_OUTPUT_COLLISION_STOP_NO_RETRY')
    if not isinstance(profile, dict) or profile.get('status') != 'ISSUED':
        raise PreflightError('ACTUAL_ISSUED_PROFILE_REQUIRED')
    if profile.get('task_id') != TASK_ID or profile.get('tier') != 'T0':
        raise PreflightError('EXACT_TASK_T0_PROFILE_REQUIRED')
    if profile.get('recipe_id') != RECIPE_ID or profile.get('training_allowed') is not True:
        raise PreflightError('EXACT_TRAINING_RECIPE_AUTHORITY_REQUIRED')
    if profile.get('production_allowed') is not False or profile.get('qualification_allowed') is not False:
        raise PreflightError('NON_PRODUCTION_ENGINEERING_ONLY')
    if profile.get('dataset_parent_boundary') != 'TRAINING' or profile.get('dataset_purpose_id') != 'training':
        raise PreflightError('TRAINING_PARTITION_AND_PURPOSE_REQUIRED')
    if profile.get('corpus_sha256') != recipe['corpus_sha256']:
        raise PreflightError('EXACT_APPROVED_SYNTHETIC_CORPUS_REQUIRED')
    pins = profile.get('source_lock', {})
    if not isinstance(pins, dict):
        raise PreflightError('SOURCE_LOCK_OBJECT_REQUIRED')
    if pins.get('runner_sha256') != runner_sha256 or pins.get('recipe_sha256') != recipe_sha256:
        raise PreflightError('EXACT_SOURCE_AND_RECIPE_PINS_REQUIRED')
    if recipe.get('runner_sha256') != runner_sha256:
        raise PreflightError('RECIPE_RUNNER_PIN_MISMATCH')
    if type(profile.get('max_attempts')) is not int or type(profile.get('max_sgd_updates')) is not int or profile.get('max_attempts') != 1 or profile.get('max_sgd_updates') != 16:
        raise PreflightError('ONE_ATTEMPT_SIXTEEN_UPDATES_REQUIRED')
    if type(profile.get('max_wall_seconds')) is not int or type(profile.get('host_hard_timeout_seconds')) is not int or profile.get('max_wall_seconds') != 30 or profile.get('host_hard_timeout_seconds') != 120:
        raise PreflightError('EXACT_WALL_BUDGET_REQUIRED')
    output_root = profile.get('output_root')
    if type(profile.get('max_artifact_bytes')) is not int or profile.get('max_artifact_bytes') != MAX_BYTES or type(output_root) is not str or not output_root:
        raise PreflightError('EXACT_ARTIFACT_SCOPE_REQUIRED')
    # Lexical Path comparison normalizes native separators without any filesystem
    # resolution. Relative paths, other roots and parent-traversal aliases deny.
    normalized_output = Path(output_root)
    if not normalized_output.is_absolute() or normalized_output != OUTPUT_ROOT:
        raise PreflightError('EXACT_ARTIFACT_SCOPE_REQUIRED')
    if not isinstance(host_verified_state, dict) or host_verified_state.get('status') != 'EXTERNALLY_ADMITTED_FOR_EXACT_EXECUTION':
        raise PreflightError('EXTERNAL_HOST_ADMISSION_REQUIRED_NOT_CALLER_BOOLEAN')
    for key in ('owner_authority_ref', 'claim_id', 'data_permission_ref', 'device_ref', 'window_ref', 'profile_record_ref'):
        if not isinstance(host_verified_state.get(key), str) or not host_verified_state[key]:
            raise PreflightError('HOST_CONTEXT_REFERENCE_MISSING_' + key)
    if host_verified_state.get('task_id') != TASK_ID or type(host_verified_state.get('fence')) is not int or host_verified_state['fence'] < 1:
        raise PreflightError('CURRENT_EXACT_TASK_FENCE_REQUIRED')
    return {'status': 'LOCAL_PRECHECK_OK_EXTERNAL_AUTHORITY_STILL_REQUIRED',
            'actual_execution': 'NONE', 'authority_effect': 'NONE',
            'qualification': 'NOT_ISSUED', 'total_sgd_updates': 16,
            'execution_ready': False, 'trusted_execution_bridge_available': False}

def forward_loss(weights, pairs):
    total = 0.0
    for source, target in pairs:
        row = weights[source]
        top = max(row)
        normalizer = sum(math.exp(value - top) for value in row)
        total += math.log(normalizer) + top - row[target]
    return total / len(pairs)

def sgd_step(weights, pairs, learning_rate):
    gradient = [[0.0 for _ in range(4)] for _ in range(4)]
    for source, target in pairs:
        row = weights[source]
        top = max(row)
        values = [math.exp(value - top) for value in row]
        denominator = sum(values)
        for column in range(4):
            gradient[source][column] += values[column] / denominator - (1.0 if column == target else 0.0)
    divisor = len(pairs)
    for row in range(4):
        for column in range(4):
            weights[row][column] -= learning_rate * gradient[row][column] / divisor

def check_deadline(started, seconds):
    if time.monotonic() - started >= seconds:
        raise TrainingStopped('COOPERATIVE_DEADLINE_PRESERVE')

def exclusive_json(path, value, written):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    if written[0] + len(raw) > MAX_BYTES:
        raise TrainingStopped('ARTIFACT_BUDGET_PRESERVE')
    with path.open('xb') as stream:
        stream.write(raw)
    written[0] += len(raw)
    return digest(raw)

def checkpoint_validate(value):
    if value.get('schema') != 'clued.t0-bigram-checkpoint/1' or value.get('step') != 4:
        raise TrainingStopped('CHECKPOINT_SCOPE_MISMATCH_PRESERVE')
    if value.get('recipe_id') != RECIPE_ID or value.get('corpus_sha256') != digest(CORPUS.encode('ascii')):
        raise TrainingStopped('CHECKPOINT_RECIPE_MISMATCH_PRESERVE')
    weights = value.get('weights')
    if not isinstance(weights, list) or len(weights) != 4:
        raise TrainingStopped('CHECKPOINT_SHAPE_PRESERVE')
    for row in weights:
        if not isinstance(row, list) or len(row) != 4 or any(type(v) is not float or not math.isfinite(v) for v in row):
            raise TrainingStopped('CHECKPOINT_VALUE_PRESERVE')
    return weights

def run_training_smoke(run_dir, recipe, deadline_seconds, written=None):
    """Actual training entry, unreachable from default plan. No automatic retry."""
    validate_recipe(recipe)
    if deadline_seconds != 30:
        raise TrainingStopped('EXACT_COOPERATIVE_BUDGET_REQUIRED')
    started = time.monotonic()
    index = {char: position for position, char in enumerate(VOCABULARY)}
    pairs = [(index[a], index[b]) for a, b in zip(CORPUS, CORPUS[1:])]
    control = [[0.0] * 4 for _ in range(4)]
    split = [[0.0] * 4 for _ in range(4)]
    if written is None:
        written = [0]
    initial_loss = forward_loss(control, pairs)
    exclusive_json(run_dir / 'initial.json', {'weights': control, 'loss': initial_loss}, written)
    control_losses = []
    updates = 0
    for _ in range(8):
        check_deadline(started, 30)
        sgd_step(control, pairs, recipe['learning_rate'])
        updates += 1
        control_losses.append(forward_loss(control, pairs))
        check_deadline(started, 30)
    split_losses = []
    for _ in range(4):
        check_deadline(started, 30)
        sgd_step(split, pairs, recipe['learning_rate'])
        updates += 1
        split_losses.append(forward_loss(split, pairs))
    checkpoint = {'schema': 'clued.t0-bigram-checkpoint/1', 'recipe_id': RECIPE_ID,
                  'step': 4, 'corpus_sha256': recipe['corpus_sha256'], 'weights': split,
                  'learning_rate': recipe['learning_rate'], 'vocabulary': VOCABULARY}
    check_deadline(started, 30)
    checkpoint_path = run_dir / 'checkpoint-step4.json'
    checkpoint_hash = exclusive_json(checkpoint_path, checkpoint, written)
    with checkpoint_path.open('rb') as stream:
        checkpoint_raw = stream.read(MAX_BYTES + 1)
    if len(checkpoint_raw) > MAX_BYTES or digest(checkpoint_raw) != checkpoint_hash:
        raise TrainingStopped('CHECKPOINT_BYTES_DRIFT_PRESERVE')
    resumed = checkpoint_validate(json.loads(checkpoint_raw))
    if resumed != split:
        raise TrainingStopped('CHECKPOINT_ROUNDTRIP_MISMATCH_PRESERVE')
    for _ in range(4):
        check_deadline(started, 30)
        sgd_step(resumed, pairs, recipe['learning_rate'])
        updates += 1
        split_losses.append(forward_loss(resumed, pairs))
        check_deadline(started, 30)
    if updates != 16 or resumed != control or split_losses != control_losses:
        raise TrainingStopped('RESUME_CONTROL_MISMATCH_PRESERVE')
    result = {'schema': 'clued.t0-training-smoke-engineering-result/1',
              'recipe_id': RECIPE_ID, 'qualification': 'NOT_ISSUED',
              'evidence_scope': 'ENGINEERING_ONLY_NOT_M2_M3_OR_MODEL_QUALITY',
              'total_sgd_updates': updates, 'trajectories': {'control': 8, 'checkpoint': 4, 'resume': 4},
              'loss_evaluations': 17, 'full_batch_compute_passes': 33, 'softmax_pair_evaluations': 495,
              'external_model_or_provider_calls': 0,
              'initial_weights': [[0.0] * 4 for _ in range(4)], 'initial_loss': initial_loss,
              'final_control_weights': control, 'final_resumed_weights': resumed,
              'control_losses': control_losses, 'resumed_losses': split_losses,
              'checkpoint_sha256': checkpoint_hash, 'resume_matches_control_exactly': True,
              'elapsed_seconds': time.monotonic() - started,
              'timeout_scope': 'COOPERATIVE_ONLY_HOST_EXTERNAL_120_SECOND_LIMIT_REQUIRED'}
    check_deadline(started, 30)
    exclusive_json(run_dir / 'engineering-result.json', result, written)
    return result

def load_bounded_json(path):
    with path.open('rb') as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise PreflightError('JSON_BYTE_BOUND')
    return raw, json.loads(raw)

def no_reparse_chain(path):
    for item in [path] + list(path.parents):
        if item.exists():
            metadata = item.lstat()
            if item.is_symlink() or getattr(metadata, 'st_file_attributes', 0) & 0x400:
                raise PreflightError('REPARSE_OUTPUT_CHAIN_DENIED')
    # Sampling is a cooperative workspace check, not a physical race-proof boundary.

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--issued-profile')
    parser.add_argument('--profile-sha256')
    parser.add_argument('--host-verified-context')
    args = parser.parse_args(argv)
    if not args.execute:
        print(json.dumps(build_plan(), sort_keys=True, indent=2))
        return 0
    run_dir = None
    try:
        if not HOST_EXECUTION_BRIDGE_AVAILABLE:
            raise PreflightError('TRUSTED_HOST_EXECUTION_ENTRY_NOT_IMPLEMENTED_CURRENT_CANDIDATE_DENIES_EXECUTE')
        if not all((args.issued_profile, args.profile_sha256, args.host_verified_context)):
            raise PreflightError('FUTURE_ISSUED_PROFILE_AND_EXTERNAL_HOST_CONTEXT_REQUIRED')
        if not re.fullmatch('[0-9a-f]{64}', args.profile_sha256):
            raise PreflightError('PROFILE_HASH_REQUIRED')
        recipe_raw, recipe = load_bounded_json(RECIPE_PATH)
        profile_raw, profile = load_bounded_json(Path(args.issued_profile))
        _, host = load_bounded_json(Path(args.host_verified_context))
        if digest(profile_raw) != args.profile_sha256:
            raise PreflightError('PROFILE_BYTES_MISMATCH')
        marker = OUTPUT_ROOT / (args.profile_sha256 + '.attempt.json')
        preflight_execute(recipe, profile, host, runner_sha256=digest(Path(__file__).read_bytes()),
                          recipe_sha256=digest(recipe_raw), output_exists=marker.exists())
        no_reparse_chain(OUTPUT_ROOT)
        # Host must protect this precise cooperative output scope externally.
        OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        marker_written = [0]
        exclusive_json(marker, {'task_id': TASK_ID, 'profile_sha256': args.profile_sha256,
                               'attempt': 1, 'consumed_before_training': True,
                               'authorization_checks': 'LOCAL_SHAPE_AND_HASH_ONLY_EXTERNAL_HOST_AUTHORITY_REQUIRED'}, marker_written)
        run_dir = OUTPUT_ROOT / str(uuid.uuid4())
        run_dir.mkdir(exist_ok=False)  # Collision stops; no retry/overwrite/delete.
        result = run_training_smoke(run_dir, recipe, 30, marker_written)
        print(json.dumps({'status': 'ENGINEERING_OBSERVATION_COMPLETE', 'qualification': 'NOT_ISSUED',
                          'run_directory': str(run_dir), 'total_sgd_updates': result['total_sgd_updates']}, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({'status': 'FAILED_OR_DENIED_PRESERVE_NO_RETRY', 'qualification': 'NOT_ISSUED',
                          'run_directory': str(run_dir) if run_dir else None,
                          'error': type(exc).__name__ + ': ' + str(exc)}, sort_keys=True))
        return 2

if __name__ == '__main__':
    sys.exit(main())
