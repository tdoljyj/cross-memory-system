# Clued R4 Gate 0-B · 模型供应链与依赖报告

- 报告版本：`R4-G0-B-SUPPLY-CHAIN-v1.0`
- 生成时间：2026-08-20T21:35Z（UTC）
- 阶段：Gate 0-B · 模型供应链、依赖与离线 Runtime
- 基线：`origin/main == 286e637f0f406b9c92e1307b04cea84ec2da8bd1`（Gate 0-B 开始前已核验，未漂移）

---

## 1. Result

**Gate 0-B 供应链与运行合同全部 PASS。**

| 验收项 | 结果 |
|---|---|
| revision 官方源核验 | ✅ `919cfbe11fbf4f1b9bb321007c46c14feaf84227` 存在 |
| 白名单下载 | ✅ 6/6 文件，直连通道，无白名单外文件 |
| 逐文件 SHA-256 | ✅ 全部记录 |
| backend 锁定 | ✅ torch-cpu + transformers，版本 + wheel SHA-256 全记录 |
| trust_remote_code | ✅ `False`（无需远程代码） |
| 磁盘全口径 | ✅ 492.79 MB（≤2GB） |

---

## 2. 模型供应链

### 2.1 官方源核验

- 模型：`intfloat/multilingual-e5-small`
- 许可证：MIT
- 官方卡：https://huggingface.co/intfloat/multilingual-e5-small
- 待核验 revision：`919cfbe11fbf4f1b9bb321007c46c14feaf84227`
- **核验结果**：官方 API `sha` 字段 == `919cfbe…`（一致），共 18 个 siblings。
- 通道：**HuggingFace 直连**（`https://huggingface.co`，200 OK），未触发镜像切换。

### 2.2 下载白名单（6 文件）

官方文件树含 18 个文件（含 `pytorch_model.bin`、`onnx/*`、`sentence_bert_config.json`、
`1_Pooling/config.json`、`modules.json` 等重复格式/非 transformers 后端文件）。按合同**只下载
transformers 后端白名单 6 文件**，其余一律拒绝：

| 文件 | 大小（bytes） | SHA-256 |
|---|---|---|
| config.json | 655 | `69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959` |
| tokenizer.json | 17,082,730 | `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` |
| tokenizer_config.json | 443 | `a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b` |
| special_tokens_map.json | 167 | `d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7` |
| sentencepiece.bpe.model | 5,069,051 | `cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865` |
| model.safetensors | 470,641,600 | `1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477` |

- 总大小：**492,794,646 bytes（492.79 MB）** ≤ 2GB ✅
- 缓存根：`~/.workbuddy/vector-cache/cross-memory-system/`（仓库外、canonical `memory/` 外、不入 Git）
- 已清理 huggingface 下载的 `.cache` 中间产物（lock/tmp），staging 只保留白名单 6 文件 + receipt。

### 2.3 backend 与依赖锁定

| 组件 | 版本 | wheel SHA-256 |
|---|---|---|
| torch（CPU） | 2.13.0+cpu | `a17ff48608634db245e17e8bb00a9558554a49aeb1e4f5fe6cd039af2a10515b` |
| transformers | 5.15.1 | `b7cdf238ff583e3a58dbc7fa34da1aaf091ce063141f65a30538160bd5afe93f` |
| tokenizers | 0.22.2 | `c9ea31edff2968b44a88f97d784c2f16dc0729b8b143ed004699ebca91f05c48` |
| numpy | 2.5.2 | `85aaccb24182c25df891ad0ec333585967e115269d5f1b17f2c9ae005bc96657` |
| safetensors | 0.8.0 | `096ec1a98435df7beb08853bb5aa9081a84f23d0adc67ed1a0a10550f608373f` |
| huggingface_hub | 1.28.0 | `58a8bacb03072edfc38067065e9dc24bbb34805410fcd36a1632de0b329660bb` |

- Python：3.13.14（managed `3.13.12` 目录），OS：Windows x64（AMD64），CPU-only。
- 隔离 venv：`~/.workbuddy/binaries/python/envs/gate0b`（不污染系统环境）。

> 供应链修正记录：`pip download`（无版本约束）首次拉到 tokenizers 0.23.1，与实际安装
> 0.22.2 不一致、且 huggingface_hub 缺失；已用**精确版本**（`tokenizers==0.22.2`、
> `huggingface_hub==1.28.0`）重新下载并核对，wheel SHA-256 以**实际安装版本**为准。

### 2.4 MODEL-MANIFEST

- 原子写（临时文件 + rename）：✅
- 文件 SHA-256：`8099e598ae5782d5f86785be8cc04de44d12b93d81fc74af86608c35faf9649c`
- canonical self-hash（`self_hash` 字段）：`7e57626c357a0adbd5f6d83a9b46d38e18ef08600785035dd9ff9f218235ad5a`
  （算法 = sha256(canonical_json(manifest 移除 self_hash 字段))，见 `manifest_guard.py`）
- 去敏证据：`docs/r4-gate0/evidence/model-manifest.redacted.json`

---

## 3. 退出条件判定

Gate 0-B 退出条件「供应链、运行合同、离线与故障注入全部 PASS」已满足（运行合同与故障注入
见 `02-Embedding-Runtime-Contract-Report.md`）。无哈希不匹配，未触发停止条件。

**下一步**：Gate 0-C（安全向量索引）——R1 闭合后经产品所有者复核放行。

---

## 4. R1 修订（产品所有者裁决，2026-08-21）

R1 前两个阻断（manifest 验证未接入加载路径、验证脚本不可重放）已闭合，详见
`02-Embedding-Runtime-Contract-Report.md` §9。本报告侧补充供应链证据：

- **manifest 验证接入**：`manifest_guard.verify_model_manifest` 在加载前校验 schema / canonical
  self-hash / 模型 ID / 固定 revision / 冻结合同字段 / 白名单文件存在+大小+SHA-256 / 额外文件拒绝。
- **完整传递依赖闭包**：`requirements-gate0b.lock.txt`（35 包）全量 wheel SHA-256 见
  `evidence/artifact-hashes.redacted.json`（R1 前仅 6 个核心包）。
- **download-receipt** 已从模型目录移入 `evidence/download-receipt.json`（模型目录仅保留
  6 白名单文件 + MODEL-MANIFEST.json，额外文件一律拒绝）。
- 报告 push 口径已修正为「未 push origin/main，已保全 push 至 `r4-gate0-wip` 分支」。
