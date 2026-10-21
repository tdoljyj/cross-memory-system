# independent-ci-resident-v1 (DRAFT, not installed)

Design and draft implementation of a resident executor for the TURING independent CI, so ordinary PR batches no longer need a per-batch Owner UAC prompt, without weakening any gate.
KooYomi Task `79c32815`. Owner decisions: Decision `0d84ddbb`.

- Read first: [DESIGN.md](DESIGN.md) (Chinese).
- Nothing here has been installed or run on a host.
- The Windows and Linux scripts are dry-run by default. Their `-Apply` / `--apply` modes need a reviewed plan hash, an elevated Owner token or root, and Source v2 (DESIGN.md §7).

Offline checks (temp directories only, no host, no network, no secret):

```bash
node --test test/*.test.mjs
python -I -B -m unittest discover -s test -p "test_*.py"
node drill/offline-drill.mjs
```
