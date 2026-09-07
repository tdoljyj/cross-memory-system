"""Write platform-supplied CI execution identity, never an acceptance decision."""
import argparse
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--negative-case', required=True)
    args = parser.parse_args()
    keys = {'repository':'GITHUB_REPOSITORY', 'source_commit':'GITHUB_SHA',
            'workflow_ref':'GITHUB_WORKFLOW_REF', 'workflow_sha':'GITHUB_WORKFLOW_SHA',
            'run_id':'GITHUB_RUN_ID', 'run_attempt':'GITHUB_RUN_ATTEMPT'}
    values = {key:os.environ[name] for key,name in keys.items()}
    if not all(values.values()) or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('Actual GitHub Actions execution context required')
    values.update(contract='clued.phase2.ci-execution/v1', negative_case=args.negative_case)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(values, indent=2)+'\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
