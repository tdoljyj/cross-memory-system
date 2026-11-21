"""A docker double whose image ID comes from the archive and the image store, never from the test case (Fable ruling 0e418483, r7
phase B, section 3.1). The two rules, written here only:
  containerd store -> a loaded archive's ID is its index.json target digest (index.json manifests[0].digest);
  classic store    -> a loaded archive's ID is the config digest its manifest.json names.
Which store: the daemon.json at $FAKE_DOCKER_DAEMON, as the real host preparation wrote it: features.containerd-snapshotter false ->
classic; true, the key absent or no file -> containerd (Docker Engine 29's default). `docker info` answers by the store: overlayfs with
the io.containerd.snapshotter.v1 driver type, or overlay2 with an empty driver status. `image inspect sha256:X` succeeds only when X is
an ID this store holds. Every call is appended to $CASE_DIR/calls; the IDs it holds are $CASE_DIR/docker-images (one per line).

Run as `python -I fake_docker_store.py <docker arguments>` from an executable named docker (tests put it first on PATH).
Knobs (environment): FAKE_DOCKER_PRESENT (an ID held before any load), FAKE_DOCKER_LOAD_FAIL=1, FAKE_DOCKER_INSPECT_FAIL=1 (a held
image whose --format inspect fails), FAKE_DOCKER_REPORT_ID (the .Id --format inspect prints instead of the held ID).
"""
import gzip
import io
import json
import os
import sys
import tarfile

CASE = os.environ['CASE_DIR']
DAEMON = os.environ.get('FAKE_DOCKER_DAEMON', '')


def store():
    if not DAEMON or not os.path.exists(DAEMON):
        return 'containerd'
    value = json.load(open(DAEMON, encoding='utf-8')).get('features', {}).get('containerd-snapshotter')
    return 'classic' if value is False else 'containerd'


def held():
    p = os.path.join(CASE, 'docker-images')
    ids = open(p, encoding='utf-8').read().split() if os.path.exists(p) else []
    return ids + ([os.environ['FAKE_DOCKER_PRESENT']] if os.environ.get('FAKE_DOCKER_PRESENT') else [])


def archive_id(data):
    if data[:2] == b'\x1f\x8b':
        data = gzip.decompress(data)
    members = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as t:
        for m in t.getmembers():
            if m.isfile():
                members[m.name] = t.extractfile(m).read()
    if store() == 'containerd':
        return json.loads(members['index.json'])['manifests'][0]['digest'][7:]
    config = json.loads(members['manifest.json'])[0]['Config']
    return config.rsplit('/', 1)[-1].split('.')[0]


def main(argv):
    with open(os.path.join(CASE, 'calls'), 'a', encoding='utf-8') as f:
        f.write(' '.join(argv) + '\n')
    s = store()
    if argv[:2] == ['info', '--format'] and len(argv) == 3:
        driver, status = ('overlayfs', [['driver-type', 'io.containerd.snapshotter.v1']]) if s == 'containerd' else ('overlay2', [])
        out = {'{{.Driver}}': driver, '{{json .DriverStatus}}': json.dumps(status, separators=(',', ':'))}.get(argv[2])
        if out is None:
            return 99
        print(out)
        return 0
    if argv[:2] == ['load', '-q']:
        if os.environ.get('FAKE_DOCKER_LOAD_FAIL') == '1':
            print('Error response from daemon: fake load failure', file=sys.stderr)
            return 8
        if len(argv) == 2:
            data = sys.stdin.buffer.read()
        elif len(argv) == 4 and argv[2] == '-i':
            data = open(argv[3], 'rb').read()
        else:
            return 99
        iid = archive_id(data)
        with open(os.path.join(CASE, 'docker-images'), 'a', encoding='utf-8') as f:
            f.write(iid + '\n')
        print('Loaded image ID: sha256:' + iid)
        return 0
    if argv[:2] == ['image', 'inspect']:
        ref = argv[-1]
        if not ref.startswith('sha256:') or ref[7:] not in held():
            print('Error response from daemon: No such image: ' + ref, file=sys.stderr)
            return 1
        if len(argv) == 5 and argv[2] == '--format' and argv[3] == '{{.Id}}':
            if os.environ.get('FAKE_DOCKER_INSPECT_FAIL') == '1':
                return 9
            print('sha256:' + (os.environ.get('FAKE_DOCKER_REPORT_ID') or ref[7:]))
            return 0
        return 0 if len(argv) == 3 else 99
    if argv == ['image', 'ls', '--no-trunc', '--digests']:
        print('REPOSITORY   TAG       DIGEST    IMAGE ID   CREATED   SIZE')
        for iid in held():
            print('<none>       <none>    <none>    sha256:%s   1 second ago   1MB' % iid)
        return 0
    return 99


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
