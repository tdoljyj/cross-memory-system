"""Fixed root-operated auxiliary Evidence transport; never a GA/host/SQL entry."""
import sys
import json
import hashlib
import importlib.util
from pathlib import Path
import datetime

ROOT = Path(__file__).resolve().parents[1] / 'kernel-phase2-repo'
SOURCE = Path(__file__).resolve().with_name('original_input_publisher.candidate.py')
EXPECTED = '95e6d206204898037c104a50968dd639edf41750ae44dba5d88095e22aabeb85'

def need(value, message):
    if not value:
        raise ValueError(message)

def main():
    need(len(sys.argv) == 1 and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
         'FIXED_ISOLATED_NO_SITE_NO_BYTECODE_INVOCATION')
    need(Path(sys.executable).as_posix().lower() == 'c:/users/windows/appdata/local/programs/python/python312/python.exe', 'FIXED_PYTHON')
    need(hashlib.sha256(SOURCE.read_bytes()).hexdigest() == EXPECTED, 'EXACT_ACCEPTED_PUBLISHER')
    spec = importlib.util.spec_from_file_location('exact_original_input_publisher', SOURCE)
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    incoming = sys.stdin.buffer.read(4194305)
    need(0 < len(incoming) <= 4194304, 'BOUNDED_TRANSPORT_REQUEST')
    request = publisher.strict_transport_json(incoming)
    need(type(request) is dict and set(request) == {'ga_raw', 'original_artifact', 'expected_parent'}, 'FIXED_PUBLICATION_REQUEST')
    artifact = request['original_artifact']
    need(type(artifact) is dict and set(artifact) == {'uri', 'sha256', 'raw'} and type(artifact['raw']) is str, 'EXACT_COMPLETE_ORIGINAL_ARTIFACT')
    raw = artifact['raw'].encode('utf-8')
    parsed = publisher.raw_record(raw)
    need(parsed['ga_raw'] == request['ga_raw'], 'SAME_COMPLETE_ORIGINAL_GA_BYTES')
    ga = publisher.existing.strict_json(request['ga_raw'].encode('utf-8'))
    ga_id = ga.get('gate_authorization_id')
    need(type(ga_id) is str and publisher.re.fullmatch(r'ga_[a-f0-9]{32}', ga_id), 'FIXED_ACTUAL_GA_ID')
    need(ga.get('controller_digest') == '27ede0fc0ff6afc4d5abf2f5c9f256fe22776165746dddc19aa2693c47bbc97c', 'EXACT_NEW_CONTROLLER')
    need(ga.get('control_trust_root_generation') == 'ctrgen_2e778ca66244459f974b081edca8c04e'
         and ga.get('environment') == 'ISOLATED_TEST' and ga.get('purpose') == 'SKILL_COEXISTENCE_QUALIFICATION', 'FIXED_EXISTING_SCOPE')
    need(artifact['sha256'] == publisher.sha(raw) and artifact['uri'] == 'urn:clued:execution-evidence:ctr_414bd3c724264a83894b0c55cf2ab878:' + publisher.sha(raw), 'EXACT_ORIGINAL_URI_RAW_HASH')
    need(datetime.datetime(2026, 9, 9, 10, 13, 16, tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc) < datetime.datetime(2026, 9, 10, 10, 13, 16, tzinfo=datetime.timezone.utc), 'ORIGINAL_OWNER_WINDOW')
    attempt = 'original-inputs-' + ga_id[3:]
    # Validate complete GA/path/raw binding BEFORE any ticket or network write.
    publisher.reference(attempt, 'result', request['expected_parent'], raw)
    result = publisher.publish_once(publisher.GitHubEvidence(), attempt, 'result', raw, request['expected_parent'])
    print(json.dumps(result, separators=(',', ':')))

if __name__ == '__main__':
    main()
