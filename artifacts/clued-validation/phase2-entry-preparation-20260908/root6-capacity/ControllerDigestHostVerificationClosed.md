# 关闭：控制器摘要所依赖的 187 项主机文件已全部复验，`DRIFT_DETECTED` 系复验方法所致

**状态：`HOST_DEPENDENCY_FINDING_CLOSED_NO_WRITE_PERFORMED`。**

关闭 `ControllerDigestDependsOnUnverifiedHostFinding.md`。
**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

证据：`host-verification-20260912/HostVerification.json`
（6,885 字节，sha256 `741ee7c3ddbb1f016f9ef4e2b511de5a63523a863c91c9aede12b38ca2ea7746`，逐字节原样存档）。

---

## 一、结论先说

| 角色 | 项数 | 在哪里验的 | 结果 |
| --- | --- | --- | --- |
| `RUNTIME_DEPENDENCY` | **187 / 187** | 那台 Windows 主机 | 全部一致 |
| `REPOSITORY_SOURCE` | **144 / 144** | 本仓库，对 git | 全部一致 |
| 合计 | **331 / 331** | | **无真实漂移** |

`ControllerSourceManifest.candidate.json` 自身 sha256 = `72d9eb92cf287ee6fda1fdbb97d90d02ed7f0e368398cba4ddb517233413d145`
——**正是七份文档所钉的控制器摘要**。主机端脚本读到的 manifest 摘要与本仓库实测相同，两侧用的是同一份字节。

另：`gh_exe.status = MATCHES_BOTH_PINS`。
`gh.exe` 同时被 manifest 与 `trusted-github.mjs` 各钉一次（`e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3`），两处都对上。

## 二、那么 `verdict: DRIFT_DETECTED` 是怎么回事

报告给出 312 通过、1 不匹配、18 缺失。**这 19 项全部是 `REPOSITORY_SOURCE`。**
这一句不是眼看出来的，是把 19 个路径逐个回查 manifest 的 `role` 字段数出来的：

```
problem entries: 19
their roles: {'REPOSITORY_SOURCE': 19}
paths not present in manifest: []
```

成因只有一个：脚本对**仓库相对路径**解析到的是那台机器上的旧检出
`C:\Users\Windows\.codex\projects\codex-memory-system\`，而脚本本身是从同一远端的新提交解包到临时目录运行的。旧检出：

- **没有** `control-context-verifier-root6-window10-successor/` 这个目录（它只存在于 `claude/nice-fermat-njqlmm`）→ 17 项「缺失」
- **没有** `commitment-signing-root6-window/signing.mjs`（同样是本轮新增）→ 第 18 项「缺失」
- `commitment-signing-next-window/signing.mjs` 停留在旧版本 → 唯一 1 项「不匹配」

那一项已在本仓库实测：

| | 字节 | sha256 |
| --- | --- | --- |
| manifest 所钉 | 6,787 | `8cfd506f17d261f8a1b076f6ecfdc21a7067f66c7e2c31f79bce058378118e7e` |
| 本仓库工作树 | 6,787 | `8cfd506f…` ✔ |
| `origin/main` | 6,787 | `8cfd506f…` ✔ |
| 那台主机旧检出 | 6,636 | `9c4341f8764963f6fc4b1e73ece7c71c6cc62671129a8f64dca1f868de438de4` |

**manifest 是对的，旧检出是陈旧的。** 仓库侧文件的权威在仓库，不在那台机器上的某个检出。

## 三、这次去那台机器要拿的，恰好全拿到了

原 finding 的实质从来不是 144 项仓库文件（那些在这里就能验，`ManifestVerificationPartialFromLinux.json` 已验过一部分，本次 144/144 全部补齐）。
实质是 **187 项 runtime dependency，共 200,048,638 字节，自 2026-09-08 起只存在于那一台主机、从未被复验**——
`node.exe`、`docker.exe`、`gh.exe` 与 41 个 ajv 文件都在其中。

这 187 项**一项不落地全部通过**。这是本次唯一非去不可的事，也是唯一在 Linux 侧无论如何做不到的事。

## 四、边界：这份证据的强度到哪为止

必须说清楚，否则就是把「别人跑脚本回传的 JSON」当成「我实测」——本轮已经犯过一次同类错误。

1. **我没有观察那次运行。** 我看到的是一份 JSON，以及用户转来的一张运行结果截图。
   两者独立给出同一个 sha256 `741ee7c3…`，这排除了传输途中被改，但**不排除脚本在运行前被改**。
2. **脚本按设计不输出那 312 项的逐项清单**，只输出计数与问题项。
   所以「187/187」不是清单里数出来的，是 `331 − 19 = 312`、且这 19 项经实测全为仓库侧，两步推出来的。
   这条推理在报告计数诚实的前提下是严密的；**它的前提是报告计数诚实。**
3. 因此运行手册第 6 节第 3 项要求的**两次**复验依然成立：本次是第一次（第二次合并前），
   **第 13 步之前仍须再跑一次**。第二次跑时应当把仓库相对路径映射到那台机器上的**新检出**
   （或直接用解包出来的临时目录），预期 331/331、`verdict: VERIFIED`。
4. 本次未验的东西一件没有：`uncheckable_here = 0`。

## 五、给评估者的两条复核请求

- 复核第二节那 19 项「全为 `REPOSITORY_SOURCE`」的判定，以及由此得出的 187/187；
  这是本文件唯一的推理步骤，其余都是实测。
- 复核第四节第 2 条是否应当直接改脚本：让它在 `--out` 里带上 `verified` 的完整路径清单，
  使下一次复验不再依赖「计数诚实」这个前提。实施方倾向改，但那会改变一个已在使用中的脚本，
  故先请评估者判断是现在改、还是等第二次复验之后再改。

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件关闭一条实施方自己提出的阻断项，不签发资格、不构成授权。

---

## 附：控制器重建之后，这份复验是否仍然有效（`2026-09-12T07:2xZ`）

Owner 第一次合并之后，控制器按 T+24h 重建，manifest 由 `72d9eb92…` 变为
`3a58eb873902d1625fa6b1f2d252efed78b205e3cb04cc356f064aacd4172dae`。
运行手册要求「第二次合并前」再验一次主机 —— **实测表明这一次不必再跑那台机器**，
理由是测出来的，不是推断的：

逐条比对新旧两份 manifest：

| 角色 | 旧 | 新 | 逐字节相同 | 变更 | 新增 | 移除 |
| --- | --- | --- | --- | --- | --- | --- |
| `RUNTIME_DEPENDENCY` | 187 | 187 | **187** | 0 | 0 | 0 |
| `REPOSITORY_SOURCE` | 144 | 144 | 127 | 0 | 17 | 17 |

- **187 项 runtime dependency 一条未动**（路径、`sha256`、`bytes` 全同）。
  今早在那台 Windows 主机上 187/187 通过的，正是这同一组摘要。
- 变的只有 17 项仓库文件：`root6-window10-successor/` 目录整组移除、
  `root6-window11-successor/` 整组新增。**这 17 项全部在本仓库内**，
  已随新 manifest 在此处实测 144/144 通过。

**合计仍是 331/331，且需要那台主机的那一半没有发生任何变化。**

**这不解除第 13 步之前的第二次复验。** 那一次防的是**从现在到那时**的漂移
（`gh.exe` 与 Docker Desktop 会自动更新，`.pyc` 会在源文件 mtime 变化时重建），
与本节所证的「重建没有改动 runtime 那一半」是两件事。
