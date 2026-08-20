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
  `trust_remote_code=False` + `local_files_only=True`，维度运行时核验）。
- 工作区脚本（gitignored `.gate0-workspace/`）：`download_model.py`、`make_model_manifest.py`、
  `smoke_test.py`、`verify_determinism.py`、`fault_injection.py`、`reference_check.py`、
  `wheel_hashes.py`。

## 8. 退出条件

Gate 0-B 运行合同、离线、确定性、故障注入全部 PASS。未触碰真实 Binding、未 push、未 tag、
未 release。下一步 Gate 0-C（安全向量索引）。
