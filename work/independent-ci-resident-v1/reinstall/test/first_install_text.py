"""first-install.py's script texts and helpers, read as text (ast), never run as the generator: the module-level string names that are
computable from the earlier ones (A, B, COMMON and their fragments), and a module-level function by name. Shared by the tests that cut a
segment out of the actual A or B text and run it under native Git Bash with doubles."""
import ast
from pathlib import Path
import re

FIRST_INSTALL = Path(__file__).resolve().parents[1] / 'linux' / 'first-install.py'


def tree():
    return ast.parse(FIRST_INSTALL.read_text(encoding='utf-8'))


def names():
    ns = {}
    for node in tree().body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                ns[node.targets[0].id] = eval(compile(ast.Expression(node.value), '<const>', 'eval'), {'__builtins__': {}}, ns)
            except Exception:
                pass
    return ns


def function(name):
    """A module-level function of first-install.py (with re available), or None when there is none of that name."""
    node = next((n for n in tree().body if isinstance(n, ast.FunctionDef) and n.name == name), None)
    if node is None:
        return None
    ns = {'re': re}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(FIRST_INSTALL), 'exec'), ns)
    return ns[name]
