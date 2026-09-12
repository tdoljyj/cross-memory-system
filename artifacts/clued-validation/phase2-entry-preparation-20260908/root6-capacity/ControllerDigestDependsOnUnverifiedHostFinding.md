# 发现：控制器摘要钉住了一台机器上 200 MB 本地文件，而本轮无人复验过它们

**状态：`FINDING_NO_WRITE_PERFORMED`。**

由实施方在返工第八轮缺件时发现。**未写库、未注册代际、`charged_seconds` 仍为 9906/10506。**

这不是新信息——`ControllerSourceManifest.candidate.json` 一直在仓库里。
**新的是我此前从未评估过它的后果**，而后果直接影响控制器重建这一步。

---

## 一、事实

控制器摘要 `72d9eb92…` 就是 manifest 文件的 sha256。该 manifest 有 331 条，其中：

| 角色 | 条数 | 字节 |
| --- | --- | --- |
| `REPOSITORY_SOURCE`（仓库内文件） | 144 | — |
| **`RUNTIME_DEPENDENCY`（那台 Windows 机器上的本地文件）** | **187** | **200,048,638** |

187 条的构成：

| 类别 | 条数 | 字节 |
| --- | --- | --- |
| `.exe` | 6 | 181,018,256 |
| `.pyd` / `.dll` | 6 | 16,102,448 |
| **`.pyc`（Python 字节码缓存）** | **44** | 1,128,786 |
| 其余（node_modules 含 ajv 41 条、`.codex` 项目文件 45 条、`normal60` 28 条等） | 131 | — |

六个可执行文件：

```
C:/Program Files/nodejs/node.exe                                   92,825,416 B
C:/Program Files/Docker/Docker/resources/bin/docker.exe            43,247,024 B
C:/Program Files/GitHub CLI/gh.exe                                 41,775,416 B
C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe             2,569,832 B
C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe             495,616 B
C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe   104,952 B
```

`gh.exe` 另有一层：`trusted-github.mjs:13` 在**每一次** API 调用前校验其 sha256
等于 `e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3`，不等即
`GITHUB_CLI_BYTES_DRIFT`。

---

## 二、为什么这是问题

**这 200 MB 的任何一个字节变化，控制器摘要就不再是 `72d9eb92…`。** 而变化的来源是常规的、无人为干预的：

- **`node.exe` / `gh.exe` / `docker.exe` 的自动更新。** GitHub CLI 与 Docker Desktop 默认自动更新。
- **44 个 `.pyc`。** CPython 的 `.pyc` 头部记录源 `.py` 的 mtime 与 size；
  源文件被任何操作 touch 过（重装、同步工具、杀毒软件回写），字节码就会被重新生成，字节随之不同。
- **106 条在 `AppData/Local/Programs/Python/Python312/` 下**——用户目录，最容易被无意改动。

manifest 采集于 2026-09-08 至 09-12 之间。**距今已过去数日，无人复验。**

---

## 三、对控制器重建的直接影响（这一条是我自己脚本的局限）

`work/twentieth-forward/rebuild-controller-window11.mjs` 把这 187 条
**原样搬运**：从旧 manifest 复制其 `bytes` 与 `sha256`，一个都没有重新计算。
脚本注释写明了这一点，理由是本环境不存在那些文件——理由成立，**但后果我当时没有写出来**：

> **重建后的控制器摘要，建立在「那 187 个文件此刻仍是 09-08 采集时的那些字节」这个未经验证的假设之上。**

如果其中任何一条已经漂移，那么：

- 新控制器摘要是一个**从不成立的前提算出来的值**
- 围绕它重签的七份文档、Owner 的第二次合并、NW-01 写进 `accepted_binding` 的
  `subject_sha256`，全部继承这个错误
- 而错误只会在**最后一步、控制器真正运行时**才暴露——那时预算可能已经消耗

---

## 四、控制器只能在那台机器上运行

顺带确认，这一点此前也未被正面陈述：

- 控制器 7 个源文件含 Windows 绝对路径
  （`context.mjs`、`trusted-github.mjs`、`host-effect.mjs`、`tool-entry.functions.js`、
  `parent600.py`、`fixed_host.py`、manifest 自身）
- `trusted-github.mjs` 只通过 `C:/Program Files/GitHub CLI/gh.exe` 访问 API，且校验其字节
- `tool-entry.functions.js` 通过 PowerShell 调用 `C:/Program Files/nodejs/node.exe`

**所以第 13 步之后的全部执行——注册、前推、Status24、预算、GA、600 秒运行、19 项观测、GRR
——都必须在那台 Windows 机器上进行。** 本会话能做的一切都是准备。

---

## 五、必须做什么（在 Owner 第二次合并之前）

1. **在那台 Windows 机器上重新扫描这 187 条**，逐条比对 `bytes` 与 `sha256`。
2. 若**全部一致**：重建后的 manifest 可信，照原计划走。
3. 若**有漂移**：分两种情况，且都不能沉默处理——
   - 漂移的是 `gh.exe`：`trusted-github.mjs` 会立刻 `GITHUB_CLI_BYTES_DRIFT`，
     控制器根本跑不起来。这一条必须在合并之前查，不能留到运行时。
   - 漂移的是别的：需要 Owner 决定是「把新字节纳入 manifest 重算摘要」
     还是「把那台机器恢复到采集时的状态」。**前者会改变控制器身份，属实质变更，需重新评审。**
4. 扫描结果应作为一份证据文件随第二次 Owner 合并一同提交。

**这一步不能由本会话完成**，本环境没有那些文件。

---

## 六、这是第几个「无人问过」的盲区

第八轮复核记下过一句，应当在这里重复并扩写：

> 「实施方写『从第一轮起就没有人问过数据库那边准备好了吗』——这个『没有人』包括我。」

数据库那次，八轮复核只看仓库侧，直到最后一步之前才有人去读 `pg_proc`。
**这一次是同一形状的第二个盲区**：八轮复核看了仓库侧，第八轮看了数据库侧，
**没有一轮问过那台 Windows 机器上的 200 MB 现在是什么。**

三个侧面里，第三个至今无人验证，而它同样能让整条链在最后一步失效。

---

## 边界

未写库、未注册代际、未消耗那唯一一次分配、控制器自 `a573ca9` 起零改动。
本文件不接受任何对象、不签发任何资格、不构成授权。
它指出的复验工作**尚未进行**，且不能在本环境进行。
