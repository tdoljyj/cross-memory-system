# Clued Multi-Track Source Registry v0.1

**Status:** `BOOTSTRAP SOURCE REGISTRY CANDIDATE / NOT AUTHORITY / NOT FROZEN`  
**Coverage:** `49 / 49 Priority Items`  
**Authority effect:** `NONE`

> 本 Registry 把 Priority Item 的来源从“某某方案”这种模糊名字收紧成 exact source identity、SHA-256、Authority state 和 Receipt state。它不创建 Canonical Event / Receipt；缺失 Receipt 保持 `PENDING / NOT_NORMALIZED`。

机器可读完整映射：`artifacts/priorities/source-registry.json`。

## Exact source registry

| Source ID | Kind | SHA-256 / Ref | Authority / Receipt state |
|---|---|---|---|
| `SRC-MULTITRACK-v0.2.1` | POST_DECISION_PROJECTION | `f74d1c57d36bc521f513fa4a77c7d66fd46b2d41fb7abec24e6b60bc54ff1cad` | Owner-fixed projection；Receipt pending |
| `SRC-FOUNDATIONAL-v0.1` | POST_DECISION_PROJECTION | `c56c99d31de93248675394a55cf6b9a2ce31e12428b414779a9cb2887f84da2f` | Owner-fixed projection；Receipt pending |
| `SRC-VISUAL-02.4B-R1` | POST_DECISION_PROJECTION | `5e7729fe31c5e574ef7706ff9a5f2d5e14fff0cf9c8b8054867967a805b1f692` | Owner-fixed projection；Receipt pending |
| `SRC-PERMISSIONS-v1.1` | EXACT_BASELINE_FILE | `5b54451c68de1a2f0eec4dcf6d4c3122880ab1fbfc6df798df3e7b32f9158bf2` | confirmed design baseline |
| `SRC-BRAND-v0.1.2` | EXACT_FROZEN_FILE | `b7c9a7d1816e4624de0d7ae6ee29975cfabab0c510fbbdc57b3ff953d14ed5d4` | formal frozen current；Receipt not normalized |
| `SRC-CONSOLE-v1.0` | EXACT_BASELINE_FILE | `fbe71bde978a73389f2ab6ed0057148967363f7cad73b572541552fe0c2da363` | user-confirmed execution baseline |
| `SRC-CONSOLE-v2.0` | EXACT_CANDIDATE_FILE | `6bf0b5d800af46dff10550cb240f818b6316e634f9298f8906da541122c8b709` | merged revision candidate / not frozen |
| `SRC-BUSINESS-v1.3.1` | EXACT_BASELINE_FILE | `8ff8eb60f025f5cb118cfa81f8529911cee1a5a09e1044a8dc058144626dfde5` | Owner-accepted business baseline |
| `SRC-INTEGRATION-LIFECYCLE-v0.1` | EXACT_FROZEN_FILE | `f163b2bdb510898058300e2f7ae42c774428ca6b8e206b1041a1e28ed2bbdcd1` | formal product/architecture frozen baseline |
| `SRC-SDD-v0.1` | EXACT_CANDIDATE_FILE | `34b8bc9f8bd536efa5c19ec2f9ba5b8734035b328282d523be9073e7dc11fc38` | complete plan candidate / not frozen |
| `SRC-STABILITY-v0.1` | EXACT_FROZEN_FILE | `936cb966a75765ca156f5706237467b940ea32891bbc98c2c21ec9a8b8ec06a0` | formal execution baseline / frozen |
| `SRC-CROSSHOST-v0.2.4` | EXACT_REVIEWED_CANDIDATE_FILE | `9b3de9eabc503b0036cfc79bacded5a4160b2a5896e20362fdbeb7d3a97cbf5f` | Owner adopted after independent PASS；freeze Receipt pending materialization |
| `SRC-CROSSHOST-REVIEW-v0.2.4` | EXACT_INDEPENDENT_REVIEW_FILE | `9058406c2fd34194f10f4fd3391c709e6a3a457f92e0bbe58002ed59937a7ca0` | independent PASS / MAJOR 0 / MINOR 0 |
| `SRC-MODEL-PLAN-REVIEW-v0.8.1` | EXACT_INDEPENDENT_REVIEW_FILE | `a3c0d7c346a7e40dd934f1aa5f297cc3fd8529d03b532f77b05e52cdb3784bc3` | Plan Review PASS；latest adopted revision separately reconciled |
| `SRC-INFLOW-CUSTODY-v1.0` | EXACT_CUSTODY_INDEX | `cde7411ab2c4db33a5f30b7682c7d3f8df048e0a7a054d5a79207a028ac43675` | M0 acceptance facts + explicit custody gaps |
| `SRC-HEALTH-v0.2` | EXACT_CANDIDATE_FILE | `f7521ed594475686555282dba63508e6d1d73a315cafbff1e8122fa0a3198cbf` | revision candidate / not fixed |
| `SRC-LIVE-REPO-MAIN` | DYNAMIC_REPOSITORY_OBSERVATION | `2c3a6f9d2c654614b0e5198658c8f03e32f36790` | control-plane observation / not Canonical |

## Item coverage

`artifacts/priorities/source-registry.json.item_source_map` contains **49 / 49** Priority Item source chains.

Examples:

```text
E-001
→ SRC-STABILITY-v0.1
→ dynamic repo observation only as supporting current-control-plane evidence

E-010
→ SRC-CROSSHOST-v0.2.4
→ SRC-CROSSHOST-REVIEW-v0.2.4
→ exact freeze Receipt remains pending

P-006
→ SRC-CONSOLE-v2.0
→ predecessor SRC-CONSOLE-v1.0

P-014
→ SRC-INFLOW-CUSTODY-v1.0
→ accepted preparation facts retained without pretending missing Frozen packages are mounted

R-002 ... R-010
→ SRC-FOUNDATIONAL-v0.1
→ working research artifacts may evolve separately
```

## Zero-Memory effect

`ZM12 — 依据哪些 Canonical Decision / Baseline / Contract？` is now **structurally answerable**:

```text
Priority Item
→ item source mapping
→ exact source identity
→ SHA-256 / Authority state
→ supporting source chain
→ explicit Receipt state
```

If a Receipt is pending, a fresh Agent must say `pending / not normalized`, not manufacture PASS or Canonical Authority.

Therefore structural Zero-Memory maturity advances from `20/25` to **`21/25`**. This does not close the final runtime Gate.