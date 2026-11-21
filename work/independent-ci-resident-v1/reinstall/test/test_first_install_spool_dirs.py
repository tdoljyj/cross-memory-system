"""N8 (first-install r5): every Linux directory wsprep (prepare-workspaces.py) demands must be made by the first install, or be one a named step makes.

Nothing but the first install's phase B makes the resident's run directories on a new node; prepare-workspaces.py refuses the batch when one of the
directories it lists is absent (protected() lstat), so the first batch of a new node with a local Linux role would fail. The test reads both files as
text (ast), never runs either:
  - the directory table is the one tuple prepare-workspaces.py hands to protected(..., directory=True), expanded with that file's own constants;
  - the directories the first install makes are the value of the 'ROOTS' template variable, expanded with first-install.py's own constants;
  - the A check and the B creation are the two loops over @@ROOTS@@ in first-install.py's script text.
What is asserted is the predicate the code requires (root-owned, no group/other write), not a literal mode.
  python -I -B -m unittest discover -s test -p "test_first_install_spool_dirs.py"     (from reinstall/)
"""
import ast
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent
FIRST_INSTALL = HERE.parent / 'linux' / 'first-install.py'
PREPARE = HERE.parents[1].parent / 'actions-hosted-migration' / 'independent-ci-v1' / 'src' / 'resident-v2' / 'prepare-workspaces.py'
# Required by wsprep but made by another named step, not by the first install's run-root loop.
MADE_ELSEWHERE = {
    '/opt/clued-independent-ci/source-v2': 'clued-ci-install-source-v2 --apply (clones it, makes the tree root-owned; first install checks HEAD, B6)',
    '/opt/clued-independent-ci/source-v2/.git': 'clued-ci-install-source-v2 --apply (the clone)',
}


def module_names(tree):
    """The module-level names whose value is computable from the earlier ones (strings, f-strings, tuples, joins)."""
    ns = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                ns[node.targets[0].id] = eval(compile(ast.Expression(node.value), '<const>', 'eval'), {'__builtins__': {}}, ns)
            except Exception:
                pass
    return ns


def wsprep_directories():
    tree = ast.parse(PREPARE.read_text(encoding='utf-8'))
    ns = module_names(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.For) and isinstance(node.iter, ast.Tuple) and any(
                isinstance(c, ast.Call) and getattr(c.func, 'id', None) == 'protected' and any(k.arg == 'directory' for k in c.keywords)
                for s in node.body for c in ast.walk(s)):
            found.append(tuple(eval(compile(ast.Expression(node.iter), '<dirs>', 'eval'), {'__builtins__': {}}, ns)))
    return found


def first_install_roots():
    """The directories first-install.py hands the script text as @@ROOTS@@, and the ROOTS constant the template assertion compares."""
    tree = ast.parse(FIRST_INSTALL.read_text(encoding='utf-8'))
    ns = module_names(tree)
    expr = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and k.value == 'ROOTS':
                    expr = v
    assert expr is not None, 'no ROOTS template value in first-install.py'
    value = eval(compile(ast.Expression(expr), '<roots>', 'eval'), {'__builtins__': {}}, ns)
    return value.split(' '), ns['ROOTS'], tree


class SpoolDirectories(unittest.TestCase):
    def test_wsprep_has_one_directory_table(self):
        tables = wsprep_directories()
        self.assertEqual(len(tables), 1, tables)
        self.assertGreaterEqual(len(tables[0]), 7)

    def test_every_directory_wsprep_requires_is_made_by_the_first_install_or_a_named_step(self):
        required = wsprep_directories()[0]
        made, _, _ = first_install_roots()
        missing = [d for d in required if d not in made and d not in MADE_ELSEWHERE]
        self.assertEqual(missing, [], 'prepare-workspaces.py requires these, nobody makes them on a new node')
        for d in MADE_ELSEWHERE:
            self.assertIn(d, required, 'the named exception is stale: wsprep no longer requires ' + d)
            self.assertNotIn(d, made)

    def test_a_parent_is_made_before_its_child(self):
        made, _, _ = first_install_roots()
        for i, d in enumerate(made):
            for j, other in enumerate(made):
                if d.startswith(other + '/'):
                    self.assertLess(j, i, f'{other} must come before {d}')

    def test_the_template_pair_stays_the_two_run_roots(self):
        # first-install.py asserts (workspaceRoot, runsRoot) == ROOTS against every role policy: the constant must stay that pair.
        _, roots, _ = first_install_roots()
        self.assertEqual([p.rsplit('/', 1)[1] for p in roots], ['workspaces', 'runs'])

    def test_phase_a_checks_and_phase_b_makes_them_root_protected(self):
        _, _, tree = first_install_roots()
        text = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and '@@ROOTS@@' in n.value]
        self.assertTrue(text)
        script = '\n'.join(text)
        loops = re.findall(r'for d in @@ROOTS@@; do\n(.*?)\n\s*done', script, re.S)
        self.assertEqual(len(loops), 2, 'one loop in phase A, one in phase B')
        a, b = loops
        for body in (a, b):   # the predicate: a real directory, not a link, uid 0, no group/other write
            self.assertIn('[ -d "$d" ]', body); self.assertIn('[ ! -L "$d" ]', body)
            self.assertIn('stat -c %u "$d")" = 0', body); self.assertIn('& 022 )) = 0', body)
            self.assertIn('RUN_ROOT_NOT_ROOT_PROTECTED', body)
        make = re.search(r'install -d -o (\S+) -g (\S+) -m (\d+) "\$d"', b)
        self.assertIsNotNone(make, 'phase B creates the missing directory')
        self.assertEqual((make.group(1), make.group(2)), ('root', 'root'))
        self.assertEqual(int(make.group(3), 8) & 0o022, 0, 'the mode made must satisfy the predicate wsprep requires')


if __name__ == '__main__':
    unittest.main()
