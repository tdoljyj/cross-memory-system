"""Fixed single-job consumer. Receives no credentials, mounts or raw tools."""
import contextlib
import io
import json
import runpy
import sys

probe_text = io.StringIO()
with contextlib.redirect_stdout(probe_text):
    try:
        runpy.run_path('/probe.py', run_name='__main__')
    except SystemExit as outcome:
        if outcome.code != 0:
            raise RuntimeError('ISOLATION_FAILED')
probe = json.loads(probe_text.getvalue())
assert probe['status'] == 'PASS'

def rpc(kind, **fields):
    print(json.dumps({'kind': kind, **fields}), flush=True)
    value = json.loads(sys.stdin.readline())
    assert value.get('kind') == 'reply'
    return value['value']

bootstrap = rpc('bootstrap', os_checks=probe['checks'])
assert [tool['name'] for tool in bootstrap['tools']] == [
    'clued_resource_center_mutate', 'clued_resource_center_scan_boundary']
job = bootstrap['job']
findings = rpc('tool_call', name='clued_resource_center_scan_boundary', arguments={})
assert isinstance(findings, list)
if findings:
    result = {'status': 'deny', 'error_code': 'UNAUTHORIZED_WORKSPACE_MUTATION',
              'side_effects': 0, 'findings': findings}
elif job['tool'] == 'clued_resource_center_scan_boundary':
    result = findings
else:
    result = rpc('tool_call', name=job['tool'], arguments=job['arguments'])
print(json.dumps({'kind': 'finished', 'result': result}), flush=True)
