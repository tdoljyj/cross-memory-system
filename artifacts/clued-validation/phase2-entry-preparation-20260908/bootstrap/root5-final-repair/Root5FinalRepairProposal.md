# Clued Phase 2 — Root5 final repair and single execution

The previously signed Root4 allowed one GateAuthorization. That authorization expired without dispatch and is durably closed `STALE`; immutable Root4 authority cannot honestly issue a second authorization. The accepted controller also retained Root3-only series checks, so a fresh Root4 dispatch would fail before any host effect.

This repair is the minimum authority-preserving continuation:

- Keep root set `ctr_414bd3c724264a83894b0c55cf2ab878`; append one successor generation `ctrgen_e5df432221344996afc04b5638121d96` within the existing fixed window ending `2026-09-11T10:21:05Z`.
- Publish one minimally patched controller, one same-scope qualification/runtime acceptance, one Status successor, and one corrective execution-binding forward.
- Permit exactly one final nonproduction GateAuthorization: 600 seconds and 134,217,728 evidence bytes. Cumulative ceilings become 7,506 seconds and 1,664,723,891 bytes.
- Preserve every prior Root, Status, authorization, result, event, receipt, container observation and nonrefunded charge.
- Run the unchanged 19-check isolated qualification once. First terminal result stops; no refund, reuse or automatic retry.
- No production authority, paid model use, business data, second root set, new signing identity, deletion, reset or force update.

The additional root generation is necessary because signed Root4 authority is immutable and its one-GA allowance is already consumed. No new trust mechanism is introduced.
