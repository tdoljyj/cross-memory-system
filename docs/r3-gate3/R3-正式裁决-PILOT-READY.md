# R3 正式裁决记录（产品所有者）：Gate 3 PASS / PILOT-READY

- **裁决时间**：2026-08-20T（UTC，以提交时间为准）
- **验收 HEAD**：`4a04e52404fc68cea8014e4b5eaa71dce99674f3`
- **裁决主体**：Gate 3 授权范围内 PASS，**不需要重新执行**

## 1. 分层裁决（固化）

| 层级 | 裁决 |
|---|---|
| Gate 3 授权范围 | **PASS** |
| 仓库 `4a04e52` / Adapter 实现 | **ENFORCED-CAPABLE** |
| 临时 home conformance Binding | **ENFORCED** |
| 用户真实环境 Binding | **ADVISORY/AUDIT** |
| R3 整体 | **PARTIAL / PILOT-READY** |
| 发布状态 | **未发布** |

## 2. 保留限制口径（不得扩展）

### 2.1 ENFORCED-CAPABLE 仅适用于
- 精确 revision `4a04e52`；
- 已验证的 Adapter 合同版本（contract_version=1）；
- 已执行版本矩阵中的平台和运行时（Windows / Python 3.13.x）；
- 通过 conformance 的具体构件组合。

**不得**扩展为"所有平台、所有 Adapter 或所有真实 Binding 已 ENFORCED"。

### 2.2 全量测试原始口径（不得简称"全量全绿"）
- 全量：**393 PASS / 60 FAIL / 31 SKIP / 0 ERROR**（32 文件）
- 归因：**ENV 60 / HEURISTIC 0 / UNKNOWN 0**
- 发布材料中不得以"全量全绿"简称替代上述原始口径。

## 3. 后续权限矩阵（当前全部 NO）

| 权限 | 裁决 |
|---|---|
| 真实环境试装 | **不授权** |
| 真实 Binding 切换 ENFORCED | **不授权** |
| 六动作真实环境执行 | **不授权** |
| push | **不授权** |
| tag / release | **不授权** |
| 真实 purge | **不授权** |

## 4. 下一步：真实环境受控试装（单独申请）

申请材料必须明确以下 7 项：

1. **目标**：目标 Agent、Binding ID 和 Adapter 版本；
2. **版本矩阵**：产品/协议/组件/合同/schema 版本矩阵结果；
3. **路径白名单**：将新增、修改、备份的真实路径白名单；
4. **Windows 语义**：Windows 权限与原子写语义；
5. **执行顺序**：install → conformance → enable 的执行顺序；
6. **回滚**：失败回滚及恢复到 ADVISORY 的方法；
7. **零修改证明**：canonical memory、其他 Binding 和共享 Core 的零修改证明；
8. **排除项**：明确排除 purge。

## 5. 受控试装后的裁决路径

- 受控试装通过后，才可**逐 Binding** 裁决 ENFORCED；
- push、tag、release 继续分别裁决（当前 NO）。
