# Fixed internal host bridge

This closes the Python subprocess port for the trusted fixed Node entry. It does not independently grant permission and accepts no serialized `authorized` flag or substitute acceptance. The Node entry must verify the complete accepted source set before starting the interpreter, validate actual signatures, obtain the trusted fresh SQL dispatch response and exact prior committed Intent in the same process, and only then invoke this port directly. The ordinary controller entry permits CREATE/START only. STOP/INSPECT are fixed safety operations for that same prepared subject; no arbitrary command or target path exists.

Interpreter: `C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe`, SHA-256 `4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a`. Fixed invocation is that interpreter, `-I -S -B -X utf8`, then the exact reviewed `bridge.py` path. No other arguments. The caller supplies only a bounded single UTF-8 JSON object through stdin, closes stdin, retains the process handle and applies the accepted GA absolute deadline. Its environment must use the existing explicit Windows infrastructure allowlist, never an inherited credential environment.

Input has exactly five fields:

```json
{"operation":"CREATE","nonce":"<32 lowercase hex>","ga_raw":"<complete original UTF-8 JSON string>","ga_sha256":"<SHA-256 of ga_raw bytes>","container_id":null}
```

START/STOP/INSPECT require the exact existing 64-hex container ID. Complete GA bytes are limited to 65,536 bytes; the outer input to 131,072. Duplicate JSON keys, unknown fields/operations, changed bytes, arbitrary paths and engineering requests are rejected. These are input checks, not Schema/authority acceptance. CREATE alone calls fixed `host.prepare` and then `create_fixed`; an existing reservation refuses redispatch. START arms the independent exact-ID watchdog, performs the fixed prestart/START, and inspects actual running state. It never passes Skill content as executable code. CREATE and START evidence each uses exclusive local files; any uncertain re-entry remains refused.

On success, stdout is one JSON object with `state=ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT`, operation, ga_sha256, exact container_id, the actual Docker inspection, started_utc/ended_utc, and START's actual guard_pid. It explicitly keeps remote_result_persisted=false, capacity_released=false and qualified=false. The trusted caller must convert this actual observation into the existing CREATED/RUNNING/STOPPED event raw binding and durably commit/read it back; no local success is a GRR. Errors return UNKNOWN, never retry or release capacity, and the independent watchdog remains responsible for its fixed deadline. No real host action has been run through this new bridge.

Dependencies remain the exact accepted host `430445f80986ba99a6f9b149a5a73cffe88182b26b0574b9f83fcdcbf64e69b2` and its closed immutable imports. The complete SourceManifest and accepted Node entry bind this bridge separately; this module does not accept a caller-provided manifest or untrusted plugin. Five new pure/mock checks passed in 0.001 seconds. No Docker, subprocess or network operation occurred in those checks.
