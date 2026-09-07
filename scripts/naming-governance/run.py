"""Portable location adapter. The verified validator predicates remain unchanged."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from naming_validator import Validator, strict_json


def main():
    parser = argparse.ArgumentParser(description='Run the existing naming governance predicates with one explicitly supplied external candidate ZIP.')
    parser.add_argument('--bindings', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--candidate-zip', required=True, type=Path)
    parser.add_argument('--purpose', choices=('evidence', 'freeze'), default='evidence')
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--node', help='Optional Node runtime override; changes execution location only.')
    args = parser.parse_args()
    try:
        selected = strict_json(args.bindings.read_bytes())
        external_locator = selected['external_candidate_locator']
        if not isinstance(external_locator, str) or not external_locator.startswith('external/') or '..' in Path(external_locator).parts:
            raise ValueError('external candidate selection must be one explicit external/ locator')
        external_path = args.candidate_zip.resolve(strict=True)
        if not external_path.is_file() or args.candidate_zip.is_symlink():
            raise ValueError('explicit external candidate must be a regular retained file')

        class LocatedValidator(Validator):
            def path(self, name):
                # The only root exception is this explicit CLI-selected read-only package.
                if str(name).replace('\\', '/') == external_locator:
                    return external_path
                return super().path(name)

        validator = LocatedValidator(args.bindings, args.source_root)
        if args.node:
            validator.bindings['node'] = args.node
        report = validator.run(args.purpose)
        report['execution_location_adapter'] = {
            'path': str(Path(__file__).resolve()),
            'sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'core_predicates_modified': False,
            'external_candidate_locator': external_locator,
            'explicit_external_candidate_path': str(external_path),
            'full_candidate_digest_recomputed_here': False,
            'candidate_digest_basis': 'Inherited exact prior package verification; source members are retained and independently rehashed by the core.',
            'node': validator.bindings['node'], 'python':sys.version.split()[0]}
    except Exception as error:
        report = {'status':'FAIL', 'exit_code':1, 'formal_step8_gate':False, 'freeze_ready':False,
                  'errors':[{'code':'INVALID_INPUT', 'detail':str(error)}]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'status':report['status'], 'exit_code':report['exit_code'],
                      'errors':[row['code'] for row in report['errors']], 'report':str(args.report)}, ensure_ascii=False))
    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
