# Fixed official reference 4B materials preparation

This helper prepares source materials and one BF16 TEXT artifact. It does not
issue permission, a Profile, a model-result record, Gold, thresholds or acceptance.
Nothing runs on import and there is no executable CLI approval flag. Root calls
one closed phase after its actual Owner approval, lawful claim, currentness and
resource checks. Local callbacks and hashes cannot authenticate that authority.
Stage entry and actual dispatch require Root's fresh normal upstream reads.
Frequent `tick` callbacks may check an independently maintained currentness
witness with fixed short freshness, revocation propagation and the same stage
deadline; they need not repeat synchronous service reads for every MiB/file.
Root must qualify that witness and reject missing/stale/revoked evidence. A
cached local value is not new authority and this helper builds no such platform.

`fixed-source-materials.json` fixes Qwen/Qwen3.5-4B revision
`851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`, 14 official files, 9,342,907,469
bytes, Apache-2.0 and non-gated metadata. Small config, index, LICENSE and chat
template were read and hashed; weights and tokenizer bodies were not read in
preparation. The 4B chat template is 7,756 bytes / SHA256
`a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715`.
The older 0.8B template must not be inherited. Git blob SHA1 authenticates each
ordinary source member against the fixed official index; LFS members also have
their original SHA256. An independent full read follows streaming verification.

The three phases have separate create-only attempt locks and shared monotonic
stage deadlines: `download_verify` 2,700 seconds, `convert_bf16_text` 1,800 seconds,
and `hash_artifact` 600 seconds. An absolute UTC stop also applies. No operation,
file, redirect or currentness/resource check resets that stage deadline. A failed
phase cannot retry or resume its directory; all locks, partial files and bounded
raw converter captures remain. These limits are ceilings, not duration estimates.

`Context` binds the exact catalog SHA, request digest, UTC stop and original Root
callbacks. `check_current(phase, request_digest)` must reject lost authorization;
`observe(root)` supplies fresh actual available RAM, free disk, cumulative new
storage high-water and its monotonic capture time. It must include all new storage
within the actual approved operation, not just the final directory. Conversion
requires at least 16GiB available RAM, checked freshly before dispatch. A prior
snapshot is not a promise of future capacity. Missing or stale facts HOLD.

The only new directory is an immediate `reference4b-*` child of the workspace
`work/model-program-progress/m1-4b-reference-preparation`. Existing/reparse/link
targets are rejected. Checks include the existing material root itself and every directory ancestor of
source/tmp/outputs/evidence accesses, repeated at stage entry and before effects.
They reject junction/reparse parents as well as leaf links. Ordinary pathname
checks cannot atomically seal directories against concurrent substitution; Root
must retain exclusive control of the owned namespace for TOCTOU qualification.
The helper retains the original create-only and independent source-hash controls
from M1, without using old 0.8B download/package permissions,
runtime downloads, pip installation, quantization or four-precision recipes.

The download makes one body stream per member and never retries. Only HTTPS
Hugging Face and a closed official CDN redirect-host list are accepted, at most
three redirects; a new host HOLDs. Redirect/error bodies are closed unread.
Unencoded Content-Length must match the fixed member. Every body byte delivered
to the writer, including incomplete/failed reads, consumes the shared 10GiB
counter before it is written; no per-file reset. There is no cache or overwrite.
The evidence reports response-body bytes, with wire bytes explicitly unknown:
TLS/header/request overhead is not measured by this helper. If the actual grant
means wire/network-interface traffic rather than response-body flow, Root must
provide a qualified external traffic cap; this Source does not relabel the count.

The existing converter code, all local conversion/gguf modules, the complete venv,
base Python stdlib and DLLs were fingerprinted without import/execution. The short
catalog records five whole-tree hashes and six single-file identities. A tree
hash covers sorted relative-path/size/SHA256 rows, including existing bytecode;
only base `Lib/site-packages` is excluded. The isolated `-I -S -B` bootstrap adds
only the fixed converter, local gguf and venv site-packages paths and bypasses
user/site/.pth processing. Native Windows system libraries remain the existing
Host boundary. Actual conversion rechecks closure before imports. No new runtime,
package installation, remote code option, precision or multimodal artifact is
requested. The fixed converter receives `--outtype bf16 --use-temp-file` and its
normal TEXT selection, offline HF/Transformers settings and private temporary
paths. CPU-only torch is the fixed existing environment,
with `OMP_NUM_THREADS=8` and `MKL_NUM_THREADS=8`. Root's qualified owned runner
must additionally restrict its Job/process affinity to eight CPUs; environment
variables alone are not an enforced CPU resource cap. This is conversion,
not model inference or tokenizer execution during Source preparation.

The 32GiB ceiling is checked before conversion by a deterministic static formula,
not an end-of-run directory scan. After all original bytes are independently
verified, only the two safetensors JSON headers (at most 8MiB each) are read for
shape/dtype/offset facts. Their exact 738 names, shard assignment, contiguous data
coverage and 9,319,737,856 payload bytes must match the fixed index. No tensor body
is parsed by that check. The fixed Qwen3.5 TEXT inheritance generates no extra
tensors, and its reorder/split/add operations preserve element counts. Ordinary
known two-dimensional dense projection/embedding weights are bounded at BF16;
all other tensors, including vision tensors TEXT drops, are conservatively F32.
Quantized, MoE/MTP, unknown dtype or malformed header cases HOLD. The formula adds
64 bytes per potential output tensor for alignment, one complete temporary tensor
stream, one simultaneous final tensor stream, a reserved GGUF metadata allowance of 16 times
all non-weight source bytes plus 16 bytes per fixed vocab entry plus 1MiB, and
16MiB for captures/evidence. Raw files/failed partials stay counted. A sum above
32GiB HOLDs before converter launch. Fixed source evidence spans are in the
catalog; the formula is tied to the fixed code closure and still needs review.
The Source bootstrap adds a child-process-only writer guard: it refuses actual
cumulative aligned tensor bytes before each temporary write and counts the fixed
writer's exact serialized KV and tensor-info bytes before any final output open.
Thus the metadata allowance is enforced, not presumed to fit from a multiplier.
Only one single-temp writer is allowed, and final output is reserved with `xb`
before the existing writer receives its expected EMPTY state. Existing converter
files and tensor values are unchanged; this guard is part of the new helper Source
binding and must be reviewed with the isolated bootstrap.
Resource observations provide additional live refusal, not the proof by themselves.

Root supplies its qualified `owned_runner(recipe, deadline, capture_limits,
resource_check)` composition: fixed CPU-only owned process/job, descendant cleanup,
complete bounded captures, shared deadline and periodic actual resource checks.
The helper does not authenticate an arbitrary runner callback. Blocking OS/file/
TLS calls cannot be universally canceled by Python deadline checks; Root must
qualify the phase Host, provide an external owned hard stop and preserve incomplete
evidence on kill. No absolute return guarantee is claimed. Any native dependency,
closure drift, unexpected output/cache allocation, missing cleanup or capture is
HOLD/failure, not an inferred successful artifact.

The artifact retains a `.gguf.partial` filename through its independent hash;
`artifact-identity.json` is the observed actual byte identity, not permission to
invoke it. Root must bind that actual output SHA in real M1 and later independently
rehash the same bytes before invocation. Conversion/hashing do not establish
runtime qualification, model quality, schema correctness or formal M0–M7 status.

The accompanying tests use small technical byte/header fixtures and mocks. They
do not download, import the converter, tokenize, read model tensors or start any
process. Source testing is separate from future approved materials execution.
