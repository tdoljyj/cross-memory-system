"""Generation 13 (DESIGN §57.6, Task 3edfc598): a final upgrade package's Source commit must be one GitHub has on a branch. Every batch's
bundle is built from GitHub (build-bundle.ps1) and reads the installed Source commit's .gitleaks.toml from it; generation 9 was built
from a commit that existed only on an unpushed local branch, and every batch then ended BUNDLE_UNAVAILABLE.

Fetches the commits only (no trees, no blobs: --filter=tree:0) of every branch of <url> into a new scratch bare repository and answers
whether <commit> is among them, i.e. reachable from a branch. A fetch by the commit's SHA would not do: a server that keeps an
unreachable object may still hand it out. For the same reason the commit is never looked up by its SHA here: the scratch repository is
a partial clone, and git would fetch a missing object from the remote on demand (GIT_NO_LAZY_FETCH stops that only from git 2.44 on).
The answer is whether it is in the list of commits the fetched branches reach (rev-list --all, --missing=allow-promisor: never fetch
while walking). The fetch is bounded (FETCH_TIMEOUT_S, and git's own low-speed abort): a line that hangs is REMOTE_UNREACHABLE, and
the whole process tree (git and its git-remote-https) is ended so the scratch directory can be removed. git is the one build-bundle.ps1
uses (Git for Windows' fixed path) where it exists, else the one on PATH. NON-elevated; writes only its own temporary directory,
removed at the end.

  python -I source-on-github.py <url> <40-hex commit>
exit 0 ON_REMOTE, 3 NOT_ON_REMOTE (the remote answered; no branch reaches the commit), 4 REMOTE_UNREACHABLE (the fetch failed), 1 usage.
"""
import json, os, re, shutil, signal, subprocess, sys, tempfile

HEX40 = re.compile(r'\A[0-9a-f]{40}\Z')
FETCH_TIMEOUT_S = 600
# git aborts a transfer slower than 1 KB/s for 60 s (http); the subprocess timeout bounds every protocol.
LOW_SPEED = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60']


FIXED_WINDOWS_GIT = r'C:\Program Files\Git\cmd\git.exe'   # build-bundle.ps1's $Git
GIT = FIXED_WINDOWS_GIT if os.name == 'nt' and os.path.isfile(FIXED_WINDOWS_GIT) else 'git'


def end_tree(proc):
    """Ends a timed-out git and every process it started (git-remote-https holds the scratch directory open on Windows)."""
    try:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True, timeout=30)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()
        proc.communicate(timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass


def git(args, cwd=None, timeout=FETCH_TIMEOUT_S):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')}
    # Defence in depth (git 2.44 and later): a partial clone never fetches a missing object on demand.
    env.update({'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C', 'GIT_NO_LAZY_FETCH': '1'})
    group = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    proc = subprocess.Popen([GIT, *LOW_SPEED, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **group)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        end_tree(proc)
        return subprocess.CompletedProcess(args, 124, '', 'timeout')
    return subprocess.CompletedProcess(args, proc.returncode, out, err)


def answer(status, code):
    print(json.dumps({'status': status}))
    return code


def main(argv):
    if len(argv) != 2 or not HEX40.match(argv[1]) or not (argv[0].startswith('https://') or argv[0].startswith('file://')):
        return answer('USAGE', 1)
    url, commit = argv
    scratch = tempfile.mkdtemp(prefix='source-on-github-')
    try:
        if git(['init', '-q', '--bare', scratch]).returncode != 0:
            return answer('REMOTE_UNREACHABLE', 4)
        fetched = git(['-C', scratch, 'fetch', '-q', '--no-tags', '--filter=tree:0', url, '+refs/heads/*:refs/remote-branches/*'])
        if fetched.returncode != 0:
            return answer('REMOTE_UNREACHABLE', 4)
        listed = git(['-C', scratch, 'rev-list', '--all', '--missing=allow-promisor'])
        if listed.returncode != 0:
            return answer('REMOTE_UNREACHABLE', 4)
        present = commit in set(listed.stdout.split())
        return answer('ON_REMOTE', 0) if present else answer('NOT_ON_REMOTE', 3)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
