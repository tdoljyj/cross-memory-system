# V17 原始 Release ZIP 复验

结论：`EXACT_RELEASE_BYTES_CONFIRMED / PASS_WITH_HISTORICAL_PATH_WARNINGS`。

本报告仅确认 Frozen 字节与归档完整性，不签发 G0A、血缘闭合、Phase 1 Closeout Bridge 或全架构审计通过。

## 上传原件

原始文件：`C:\Users\17531\Downloads\Clued-Kernel-Next-V17-Local-RC-20260903.zip`

- bytes：848941
- SHA-256：`66b71187e6e467a44aa1149bf5c757efa64bfb99620d37a43e0d5bf2678bb1b4`
- 已与认证 GitHub Release 的服务端 size/digest 核对一致。
- 使用现有本机原件；未重新压缩、未修改、未声称已上传至另一审计任务。

## 复验结果

- ZIP 成员：89；总解压字节：3286984。
- CRC 错误、重复名、大小写/Unicode 名称冲突、路径穿越、加密、Symlink、嵌套归档：均为 0。
- 根 SHA256SUMS：88/88，精确覆盖根清单自身之外的全部文件。
- 嵌套相对路径清单：38/38、2/2、12/12。
- 两份历史绝对 Windows 路径清单：9/9 与 16/16 均按 SHA-256 在归档内部定位到相同字节。未访问或执行任何历史路径。这是内容定位证明，不是原路径可移植性证明。
- 一个历史 aggregate 清单为 0 条记录；不把它单独视为闭合证据。相关文件仍由根清单和后继清单覆盖。

## 关键原件定位

- Terminal Receipt：`06-v17/V17-INDEPENDENT-LOCAL-RC-REVIEW-v15.json`，5481 bytes，SHA-256 `24da22d93758b7a2a220eda0ca400ad62ba1190e8b53460805adced4f4b02a8a`。
- RC Artifact：`02-v12-real-supply-chain/final-artifact.clued-local-rc.json`，951954 bytes，SHA-256 `f6d83b515581d2c8e9ed4d41bf329b83f22d07fe9e2b12e5fbf67c15c1695787`；OCI blob 中另有一份逐字节相同副本。
- Receipt 内记载的候选 Commit：`e4b3cd08face6c848cac941a6a00512a1ddf9ace`；Tree：`7205d419fa83171126c98e14585bdcf8de3962bf`。
- Receipt 原文裁决：`PASS — CLUED_KERNEL_NEXT_LOCAL_IMPLEMENTATION_ACCEPTED_UNDER_V15 / LOCAL_RC_ONLY`。这里是读取原件所见声明，不是本轮重新签发的语义审计裁决。

## 限制与下一步

原始验收回执里的 `NOT_PUBLISHED`、`NO_REMOTE_GIT_WRITE` 是其生成时点记录，后续 GitHub 交付没有改写这些字节。G0A 是否 PASS/N/A/SUPERSEDED 仍由接收方按原件和历史证据裁决。

下一步：将原始 ZIP 上传给等待取件的审计任务，可同时上传本报告、JSON 版与 V17_CONTENT_INDEX.json。截图、链接、摘要、派生报告均不替代原始 ZIP。

远端 Release：https://github.com/tdoljyj/cross-memory-system/releases/tag/clued-kernel-next-v17-local-rc-2026-09-03

本轮未改动仓库、Branch、Tag、Release、生产环境或 Canonical 数据。初次相对路径解释的观察保留在 V17_VERIFIER_R1_STRICT_PATH_OBSERVATION.json；最终报告明确区分归档成员路径与历史清单中的路径文字。

sources_read：原始 ZIP、认证 Release 元数据、全部内部 SHA256SUMS、按摘要定位的 Terminal Receipt / RC Artifact。
