# First T0 training engineering candidate

This is a concrete **unissued, unexecuted** experiment preparation under original Task `1502fd80-8ff8-4adc-b4f5-da6d462f4f8a`. It does not change the frozen stage-admission successor or issue another Gate/Authority. [T0TrainingRecipe.v0.1.json](T0TrainingRecipe.v0.1.json) binds the exact source and literal corpus; [runner](../../../../../scripts/model-program/run_t0_training_smoke.py) uses Python stdlib only.

The model starts from sixteen zero bigram logits over `a/b/c/d`, using only the explicit synthetic `TRAINING / training` corpus `abacabadabacabad`. Nothing from development, qualification, final Holdout or protected48 enters the recipe. The data still requires exact permission in the future issued Profile. No weights, model provider, installation, GPU or download is required.

One attempt contains two trajectories: eight uninterrupted deterministic full-batch SGD updates, and four updates followed by a create-only checkpoint, reload and four resumed updates. **Total: sixteen optimizer updates**, not eight. Seventeen mean-loss evaluations and the gradient calculations cover 495 pair-softmax evaluations (at most 1980 scalar exponentials). Zero external model/provider calls does not mean zero toy computation. Initial weights/loss, per-step loss, checkpoint hash and final exact control/resume agreement are saved as engineering evidence. The checkpoint and attempt marker share a 1 MiB aggregate artifact budget; no data reads beyond the new exact checkpoint are needed during training.

Default invocation only prints a plan: it initializes no weights, computes no loss, optimizes nothing and writes no file. **Current `--execute` unconditionally refuses because no trusted execution entry is installed.** Future execution requires the actual issued exact Profile, source/recipe/profile SHA bindings and external Host verification of actual Owner, current original Task claim/fence, data/device permissions and window through an accepted trusted entry. Local CLI/JSON context checks are integrity and accidental-use guards; they cannot authenticate a Canonical Profile or authorize execution. No qualifying Profile exists in this preparation. The complete training body is retained for that later admitted entry; flipping a candidate flag or forging JSON is not an implementation of it.

Future command shape, to be filled only after exact Host admission:

```text
<approved Python> -B scripts/model-program/run_t0_training_smoke.py --execute --issued-profile <actual issued Profile> --profile-sha256 <exact issued bytes SHA> --host-verified-context <externally verified launch context>
```

Outputs are create-only in the exact repository work scope. A profile-hash attempt marker is consumed before model initialization; the same exact Profile cannot retry via a new UUID. Run collisions, mismatched sources, unexpected checkpoint content or any error stop and preserve the scene. Nothing preexisting is deleted or overwritten; no automatic retry or cleanup occurs. Cooperative checks enforce the thirty-second source budget around the tiny loop; a trusted external Host must enforce the independent 120-second process limit. Local path sampling and loop checks do not claim hostile-filesystem isolation or production hard timeout.

No shell/subprocess, network, SSH, Guest, native API, ACL change or provider model call is used. Success demonstrates toy pipeline and deterministic checkpoint/resume behavior only. It cannot issue M2/DataGate, full M3 or model-quality PASS. Future wider training retains the accepted stage and purpose contracts. This preparation has executed zero models and zero optimization steps.
