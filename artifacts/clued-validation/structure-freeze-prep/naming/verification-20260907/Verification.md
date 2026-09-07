# Step 3 外部快照与盘点器独立核验

时间：2026-09-07 07:20 UTC。范围为本次保存的语义响应快照与盘点回归；没有重新请求外部 API，没有业务状态写入，没有提交或 push。未把这些快照当作原子数据库快照或独立签名的 HTTP 原始响应。

**结论：所核对项目全部 VERIFIED；7 项回归 PASS。** 本报告不单独声明 Step 3 全范围盘点收口。

| 项目 | 独立结果 |
|---|---|
| SourceIndex 与 scope 绑定 | `scope_sha256` 已对实际 NamingSurfaceInventoryScope.json 字节自行重算并一致 |
| 13 个外部来源 | SourceIndex 路径无重复；清单与 sources 实际文件集合相等；13/13 大小及 SHA256 自行重算一致 |
| Supabase catalog | 16 页；前 15 页各 100 条，末页 62 条，总数 1562；每条 total_count=1562；按 `(kind,schema_name,parent,name,detail)` 组成的身份无重复，跨页全局排序连续 |
| Supabase 独立统计对照 | column 788、function 161、policy 31、relation 71 及 11 个 schema 名称集合，与另存 counts 响应一致；全部 kind 计数见 Verification.json |
| Cloudflare production versions | 页码 1/2/3，页条数 10/10/6；全部状态成功；每页 count/total_count 一致；26 个唯一 ID；版本 number 26→1 完整 |
| Cloudflare canary versions | 第 1 页 2 条，两个唯一 ID，number 2→1 完整；响应 count/total_count 一致 |
| 盘点器回归 | `tests/test_naming_inventory_completeness.py -v`：7 tests，全部 PASS；包括摘要破坏拒绝、重新算哈希也不能掩盖重复页、超过 50 处引用保留、长 ID 截断仍保留原值身份 |

唯一仓库修改：`tests/test_naming_inventory_completeness.py` 新增 2 个必要回归。

1. 机器路径下真实 PNG 签名文件保留路径及内容摘要，不计作未扫描文本缺口。
2. 同路径下仅扩展名伪装为 `.png` 的 UTF-8 文本仍扫描，识别 `CLUED_PNG_FIXTURE` 且标记 machine surface。

源数据核对脚本是独立实现，没有调用 consolidator 的 verify_sources 来证明其自身正确。结果及逐文件重算值保存在同目录 `Verification.json`；检查逻辑在 `verify-independent.py`。测试运行依赖当前 scanner/consolidator 工作树，未模拟成 GitHub CI 运行。

边界：1562 条无漏/无重，是相对已声明 1562 总数、唯一身份和保留分页的完整性结论。采集窗口非原子；不能据此证明采集窗口外的当前外部状态永远不变。Cloudflare 本项验证的是 versions 的 26+2 分页，不替代所有其他 API 的全量枚举声明。Library、GitHub、未扫描范围及观察项处置由整体盘点审查另行判断。
