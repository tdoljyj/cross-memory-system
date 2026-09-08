# Forward generation for the existing isolated control root

This is preparation for generation `ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12`, ordinal 2. It is not registered or active. Generation 1 and the immutable accepted binding remain unchanged.

The only issuer-algorithm change is an independently accepted dynamic signature commitment channel for GATE_AUTHORIZATION and GATE_RESULT. STATUS retains its existing algorithm with a separately accepted generation-2 purpose reference; generation-1 metadata cannot silently qualify a new generation. The Root itself retains the exact accepted schema, Owner PR-merge signature algorithm, Owner approval, scope and expiry. No keys, production, model or paid permissions are added.

The preparation helper consumes an actual complete private read_root observation and two separately accepted purpose metadata files. It validates the actual generation-1 root and predecessor canonical digest, binds the full pre-append history, and emits an explicitly unregistered review subject. Proposed blob references are content addresses only until their exact bytes have been published and independently read back. Live Root objects and full source observations remain outside Git.

After independent review of exact subject bytes, a signing payload can include the actual independent acceptance reference. Only a separately verified Owner PR merge over that payload, its immutable evidence, and a fresh same-domain append CAS can register generation 2. Changed sequence, predecessor, expiry or binding requires reevaluation; no blind retry, overwrite or second trust root.
