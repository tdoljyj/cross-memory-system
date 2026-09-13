# 第 19 步 material 的逐键来源表

**状态：`PREPARATION_ONLY_NO_WRITE_PERFORMED`。本文件不签发受理、不构成授权。**

第 19 步的「正式命令」不是一条新命令。`QualificationCases.json` 的 `formal_command` 写着
「待确认：实际受权 controller 尚未存在；禁止把本地候选 CLI 换 mode 当正式执行」，
它待确认的是两个**前提**，不是措辞：受权控制器存在（root6-runtime-v19 已签发）、
且 GA 已签发（第 17 步完成）。两者到位后命令形状是确定的，且 `local_command`
那条路被明文禁止，所以正式形态只能是：

**第 18 步那同一个固定可信入口，跑 20 次 `CURRENT_DISPATCH`，每次带同一个 GA。**

```
# 对 PQUAL-01 … PQUAL-20 逐个：
printf '%s\n%s\n' "$MATERIAL_JSON" "$FRESH_JSON" | <tool-entry.functions.js 的固定入口>
```

第一行是 material，控制器回 `{state:'NEED_COMMITTED_DISPATCH', challenge, …}`；
第二行必须回带同一个 `challenge`（`cli.mjs`：`EXACT_LIVE_PROCESS_CHALLENGE_REQUIRED`）。
每行 ≤ 4 MiB（`BOUNDED_STDIN_INPUT_REQUIRED`）。

**我没有把它写成可直接 `bash` 的脚本**，理由写在执行单 §10：material 的若干键依赖
root6-runtime-v19 两份文书的实际内容（各自 sha256 与 `publication.commitSha`），那些值现在不存在。
一份填着占位符的脚本，和一份填着猜测值的脚本，在 3 点钟的区别不够大。下表是到手即可填的清单。

---

## material 的键（【实测】`grep -o "material\.[a-z_]*" context.mjs` 的全集）

| 键 | 20 次是否相同 | 来源 | 控制器在哪里查它 |
| --- | --- | --- | --- |
| `operation` | 相同：`'CURRENT_DISPATCH'` | 固定 | `context.mjs:206`、`:228`；`'GRR'` 只用于第 20 步 |
| `observation` | **每次新抓** | 控制器自带的那条 SQL：`select clock_timestamp() as observed_at, clued_control.read_execution() as execution`（`context.mjs:17`） | `:294` 取 `material.observation.row.execution.binding`；`:305` `seriesCheck` |
| `ga_raw` | 相同 | 第 17 步 `reserve_gate` 签出的 GA 原文，含 `<GA_ID>`。**唯一来源是活库 `execution_current.active_ga_id`**，见 `step19-ga-id.sql` | `:302` `parseExact`；`:70` 比 `controller_digest`／`controller_qualification_ref.sha256`／`scope_digest`／`profile_digest` 与绑定逐字相等 |
| `runtime_acceptance` | 相同 | root6-runtime-v19 的 `Exact…ControllerRuntimeAcceptance`。形状 `{raw, publication:{commitSha, artifactPath}}` | `:296` `sha(raw)===binding.runtime_acceptance_sha256`；`:309` `ga.target_revision===publication.commitSha`；`:310` 该 `commitSha` 即 `verifySourcePublication` 的 `ownerMerge` |
| `controller_qualification` | 相同 | root6-runtime-v19 的 `Scoped…ControllerQualification`。形状 `{raw}` | `:296` `sha(raw)===binding.qualification_sha256`；`:76` `state==='ACCEPTED_SCOPED_CONTROLLER_QUALIFICATION'`、`independent_reviewer==='/root'`、**`controller_digest===binding.controller_sha256`**、`scope_digest`、`environment==='ISOLATED_TEST'`、`purpose===ga.purpose` |
| `gate_definition` | 相同 | 形状 `{raw, publication}` | `:318` `sha(raw)===binding.gate_sha256`，并 `verifyOwnerMergeArtifact` |
| `profile_signing_payload` | 相同 | 形状 `{raw}` | `:320` `sha(raw)===ga.accepted_subject.profile_signing_payload_ref.sha256`；`:322` `profileProof.profile_definition` 与控制器自带 profile 相等 |
| `status_manifest` | 相同 | 第 15 步追加的 Status24 | `:350` 的 `statusExpected` 逐字段比对 |
| `prerequisite_materials` | 相同 | R05–R10 阶段受理件 | 见 `QualificationCases.json` 的 `formal_base_requirements` |
| `grr_raw` | **仅第 20 步** | GRR 原文 | `:297` `parseExact`；`result-terminal.mjs:11`、`grr.mjs` |

## 20 次之间唯一变化的东西

`QualificationCases.json` 每个 case 的 `inputs`：`fault_variants` 与 `phase_profile_purpose`。
其余 material 键 20 次相同（`observation` 除外，它每次必须新抓）。

`local_checks` 那一列**不能**当作正式观测：每个 case 自己写着
`local_checks_do_not_prove: "No formal actor/issuer authority, real OS isolation, model
authorization, R11 qualification or Slice A acceptance"`。

## 两个要预期而不是当故障处理的结果

1. **`series_first_pass_stops`**。【实测】`reserve_gate:90` 与 `reserve_execution_budget:95`：
   `if series_a->>'phase'='PASS' then raise exception 'series_first_pass_stops'`。
   第一个 PASS 之后通路关闭。这是设计。
2. **`state:'UNKNOWN'`**。`cli.mjs` 的 600 秒看门狗在 `dispatchMayExist` 为真时给出
   `UNKNOWN` 而不是 `BLOCKED`，含义是「效果可能已发生」。
   **不要重试**；用 `step19-ga-id.sql` 与 `step19-readback.sql` 只读判定实际状态。

## 边界

未写库、未签发 GA、未跑任何观测。本文件只列来源，不含任何猜测的摘要或 id。
