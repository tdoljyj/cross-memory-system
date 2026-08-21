# Clued R4 Gate 0-B · Embedding Runtime 合同报告

- 报告版本：`R4-G0-B-RUNTIME-v1.0`
- 生成时间：2026-08-20T21:35Z（UTC）
- 阶段：Gate 0-B · 离线 Runtime、确定性、故障注入
- 基线：`origin/main == 286e637…`（未漂移）

---

## 1. Result

**离线 Runtime 合同、确定性、故障注入全部 PASS。**

| 类别 | 结果 |
|---|---|
| 离线 smoke test | ✅ 10/10 |
| reference 逐项对照 | ✅ 7/7 |
| 跨进程确定性 | ✅ 3 次 hash 一致 |
| 故障注入（fail-closed） | ✅ 5/5 |
| 冷启动 | ✅ 1.90s（≤30s） |
| 热路径 query P95 | ✅ 18.67ms（≤50ms） |

---

## 2. 冻结运行合同逐项对照（ADR R1.2 + R4-G0-PLAN §3.5）

| 合同项 | 要求 | 实测 | 结果 |
|---|---|---|---|
| query 前缀 | `query: ` | `query: ` | ✅ |
| passage 前缀 | `passage: ` | `passage: ` | ✅ |
| pooling | attention-mask mean pooling | 与独立参考实现 max_abs_diff=0.0 | ✅ |
| 归一化 | L2 | 全部向量范数=1.0 | ✅ |
| 相似度 | cosine | 内积==`torch.cosine_similarity` | ✅ |
| dtype | float32 | `torch.float32` | ✅ |
| dimension | 384 | hidden_size=384 运行时核验 | ✅ |
| max length | 512 token 截断 | 超长输入 tokens=512 | ✅ |
| query batch | 1 | batch=1 | ✅ |
| index build batch | 32 | batch=32 | ✅ |
| remote code | `trust_remote_code=False` | False | ✅ |
| offline | `local_files_only` 等价 | `HF_HUB_OFFLINE=1` 下加载成功 | ✅ |

---

## 3. 离线 smoke test（10/10）

- 模型离线加载：1.60s（`local_files_only=True` + `HF_HUB_OFFLINE=1`）
- dimension == 384、query/passage 向量 shape、L2 范数、cosine 范围、语义排序、
  进程内确定性、空输入边界 —— 全部 PASS。
- 语义排序验证：query「表格输出时喜欢哪种步骤」对「表格输出，步骤清晰」的 cosine
  （0.8937）>「结论先行分步骤」（0.8871），符合语义预期。

## 4. 跨进程确定性（3 次独立进程）

`DETERMINISM_HASH = 6e66b4838f29673652bf51f75d7e3a74608972aeaad5209866f45af4b630d93e`
三次运行完全一致；排序 `[0, 2, 3, 1]` 稳定。→ 同输入、同构件、同 backend，向量与排序可复现。

## 5. 故障注入（5/5 fail-closed）

| 场景 | 注入方式 | 结果 |
|---|---|---|
| manifest 校验（基线） | 真实目录全文件 sha256/dim/revision | ✅ 通过 |
| 缺文件 | 移走 `model.safetensors` | ✅ 加载抛异常 |
| 改 1 byte | 篡改 `config.json` | ✅ manifest sha256 捕获 |
| 错误 dimension | `hidden_size=768` | ✅ RuntimeError（dimension 核验） |
| manifest 损坏 | 篡改 manifest dimension=999 | ✅ 校验捕获 |

原则验证：任何故障均导致**加载失败**（fail-closed），无静默通过、无部分降级。

## 6. 性能（快速测量，完整测量归 Gate 0-G）

- 冷启动（进程内首次加载模型+tokenizer）：1.90s（门槛 ≤30s）
- 热路径 query batch=1：P50 7.92ms，P95 18.67ms，max 19.20ms（门槛 P95 ≤50ms，20 warm-up + 100 计时）

## 7. 代码

- 新增：`memory_engine/embedding_adapter.py`（`E5Embedder`：加载 + mean pooling + L2 + cosine，
  `trust_remote_code=False` + `local_files_only=True`）。
- 新增：`memory_engine/manifest_guard.py`（供应链 manifest 守卫，纯标准库无 torch 依赖，
  `verify_model_manifest` / `manifest_canonical_hash` / `verify_hidden_size`）。
- 新增测试：`tests/test_embedding_adapter.py`（17 项，合成 fixture，可重放）。
- 工作区脚本（gitignored `.gate0-workspace/`）：`download_model.py`、`make_model_manifest.py`、
  `smoke_test.py`、`verify_determinism.py`、`fault_injection.py`、`reference_check.py`、
  `wheel_hashes.py`、`download_all_wheels.py`。

## 8. 退出条件

Gate 0-B 运行合同、离线、确定性、故障注入全部 PASS。未触碰真实 Binding、未 push origin/main、
未 tag、未 release；Gate 0-A/B 证据已保全 push 至 `r4-gate0-wip` 分支。

---

## 9. R1 修订（产品所有者裁决，2026-08-21）

R1 前存在两个阻断：① manifest 验证未接入 `E5Embedder` 实际加载路径；② 验证脚本在
gitignored 工作区、不可独立重放。R1 已闭合：

1. **manifest 验证接入加载路径**：`E5Embedder.__init__` 在加载 tokenizer/model **之前**调用
   `verify_model_manifest`（schema / canonical self-hash / 模型 ID / 固定 revision /
   冻结合同字段 / 白名单文件存在+大小+SHA-256 / 额外文件拒绝）+ `verify_backend_versions`
   （当前环境包版本 vs manifest 记录）。任何不符 fail-closed。
2. **canonical hashing 算法明确定义**：`self_hash = sha256(canonical_json(manifest 移除
   self_hash 字段))`，`canonical_json = json.dumps(sort_keys=True, ensure_ascii=False,
   separators=(",", ":"))`。「排除该字段」口径（非置空），实现于 `manifest_canonical_hash`。
3. **batch 冻结**：`embed_query` / `embed_passages` 移除 `batch_size` 参数，固定 1/32，
   调用方不可覆盖（`test_batch_args_frozen` 用 AST 断言签名）。
4. **hidden_size 严格核验**：`getattr(config, "hidden_size", None)` + `verify_hidden_size`，
   缺失（None）或 != 384 均拒绝（此前缺失会静默通过）。
5. **输出核验**：`verify_embedding_output` 核验维度 / float32 / finite / L2，任一不符 fail-closed。
6. **可重放单元测试**：`tests/test_embedding_adapter.py` 17 项（16 项纯标准库 + 1 项 torch 守卫），
   覆盖缺文件 / 可解析文件改 1 byte / manifest 篡改 / 错误维度 / 额外模型文件 / hidden_size 缺失等。
7. **完整传递依赖闭包**：`requirements-gate0b.lock.txt`（35 包）+ `artifact-hashes.json`
   （全量 wheel SHA-256），见 `evidence/`。
8. **报告口径修正**：本节 §8 已改为「未 push origin/main，已保全 push 至 WIP 分支」。

---

## 10. R2 / R3 运行时守卫闭合（2026-08-21）

1. `verify_embedding_output` 在任何 shape 索引前显式要求二维 `[N,384]`；
   `[1,1,384]` 即使最后一维正确且归一化也拒绝，`[1,384]` / `[N,384]` 保持通过。
2. manifest 文件集合、输入前缀与 backend 依赖声明已冻结；packages 必须与完整依赖锁
   精确相等，不再只做“非空”判断。
3. 模型文件 metadata 与 backend/wheel 元数据必须匹配仓库内可信根；联合改写 artifact、
   manifest 内哈希和 `self_hash` 无法再绕过加载前校验。
4. `E5Embedder` 的加载顺序保持：生产可信根校验 → backend 版本核验 → tokenizer/model
   离线加载 → hidden size / 输出合同核验。任何一步不一致均 fail-closed。
5. 独立回归：同步层 70/70、Memory Engine 55/55、卸载场景 12/12（逐进程）通过；
   embedding 合成守卫 28 PASS / 1 torch 环境 SKIP。

**最终裁决：Gate 0-B PASS（2026-08-21，Codex@DESK-W-591 复核签核），下一阶段
为 Gate 0-C；`main` 合并、tag、release 均未执行。**
