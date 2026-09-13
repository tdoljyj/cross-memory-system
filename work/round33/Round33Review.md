# Round 33 独立复核（对抗性，不背书）

- 分支 `claude/nice-fermat-njqlmm`，复核 head **b634cc3**（`1fccf92` F12 实化冻结 + `b634cc3` 九件重出）。
- 立场：本文只记录**我自己跑出来的字节**。凡我未能亲自复算的，明写「未复现」。
- 每条结论附「复现命令」与「可失败路径」（我实际把它弄红过的那一步）。

---

## 0. 先说一件会决定后续所有会话结论真伪的事

**三闸在默认会话宿主上根本跑不起来**，而失败长得像控制器缺陷。我初次运行的结果是：

```
node check-digest-pins.mjs        -> REFUSED: 2 digest literal(s) unexplained   (exit 1)
node selftest-runtime-pins.mjs    -> FAILED (8 failed, 0 unproven)              (exit 1)
```

原因是宿主缺两样东西，都不在 git 里：

1. `/usr/local/bin/gh`（`HostProvisioning.json` 要求 gh 2.63.2，sha256 `f687dc93…`，本环境不预装）；
2. `apps/clued-cloud/node_modules`（`root-window-validation.mjs:6` 经 `createRequire` 加载 `ajv`）。

补齐后三闸全绿。补齐命令（可复现）：

```bash
cd /home/user/cross-memory-system/apps/clued-cloud && npm install --no-audit --no-fund
git checkout -- apps/clued-cloud/package-lock.json     # npm 会改动它，必须还原
curl -sSL -o /tmp/gh.tgz https://github.com/cli/cli/releases/download/v2.63.2/gh_2.63.2_linux_amd64.tar.gz
tar xzf /tmp/gh.tgz -C /tmp && sha256sum /tmp/gh_2.63.2_linux_amd64/bin/gh
#   -> f687dc937534f8aa77ff9d2362163c645b5a8cc78297ef1a642c74c56aa48618  （与 HostProvisioning.json 逐字节一致）
cp /tmp/gh_2.63.2_linux_amd64/bin/gh /usr/local/bin/gh && chmod +x /usr/local/bin/gh
```

**给后续会话的硬性提醒**：若某会话在未补齐宿主的情况下报告「三闸通过」，那就是第 17 例
「在不可能失败的条件下完成的验证」的镜像版 —— 它连跑都没跑起来。反过来，若某会话看到上面
两条 REFUSED 就断言控制器有缺陷，也是错的：`check-digest-pins.mjs` 会打印 `HOST INCOMPLETE`
行，`HostProvisioning.json` 的 `attribution_rule` 正是为此而写。

---

## 1. 发现（按严重度排序）

### R33-F1（中高）第 16 例：重出的「无残留」检查在缩写类上不可能失败，且重出**引入**了一处自相矛盾

`reissue-documents-window12.mjs` pass 4（`:449-468`）声称「nothing superseded may survive」。
实测它是**健全但狭窄**的：它只比对替换表里的**全长**值。

- 全长类：我独立扫过九件，作废控制器摘要 `68133f2d617718c8…` 的**完整 64-hex 出现次数为 0**。
  pass 4 在这一类上是真的有效。
- 缩写类：本项目通篇用 8 位前缀写摘要。`68133f2d` 在九件里出现 **26 次（豁免字段之外）**，
  pass 4 一次都看不见 —— 这一类上它**不可能失败**。

26 处大多是历史叙述，无害。但至少三处不是：

**F1a（可机械判定，重出引入）** `ExactRoot5FinalPreentryControllerRuntimeAcceptance.json`：

| | `window10_continuation_evidence.controller_digest` | 同段 `.correction` 里的 "The digest is now …" |
|---|---|---|
| v19（重出前基线） | `68133f2d` | `68133f2d` — **一致** |
| v20（重出后） | `73c05cad` | `68133f2d` — **矛盾** |

字段被重出改到 F12，描述该字段的那句话没改。基线原本是自洽的，**是这次重出把它弄成不自洽的**。

**F1b** `required_before_actual_ga[1] [2] [4]` 是「本窗口发 GA **之前**必须做到」的前瞻性义务，
仍然点名作废的控制器摘要。其中 `[4]`：
`"binding.controller_sha256 re-pinned to 68133f2d … both changed with the controller"`
—— 这是一条会被照着执行的指令，现在指向错的控制器。

**F1c** `verified_on_host.checks[3,4,6,7]` 的 `observed` / `check` 记录的是对 `68133f2d` 的宿主观测，
而文书的 `controller_digest` 已是 F12。作为「历史观测」可辩护，作为 `verified_on_host` 读起来是错的。
QUAL 同样四处。

> 我**不**替评审裁定这 26 处里哪些算历史、哪些算陈旧 —— 生成器作者在
> `Window12ReissueNotes.md §7` 已把这类判断留给评审。我做的是让这一类不再隐形。

**复现命令**
```bash
node work/round33/scan-superseded-abbreviations.mjs              # 正跑：列已知缺陷，exit 1
node work/round33/scan-superseded-abbreviations.mjs --inventory  # 打印 26 条完整清单
node -e "const fs=require('fs'),P='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/';
for(const [t,f] of [['v19',P+'root6-runtime-v19/'],['v20',P+'root7-runtime-v20/']]){
 const w=JSON.parse(fs.readFileSync(f+'ExactRoot5FinalPreentryControllerRuntimeAcceptance.json','utf8')).window10_continuation_evidence;
 const m=String(w.correction).match(/The digest is now ([0-9a-f]{8})/);
 console.log(t,'field',w.controller_digest.slice(0,8),'prose',m[1],'consistent',w.controller_digest.startsWith(m[1]));}"
```

**可失败路径**（我实际弄红过的）：`--tamper` 往 QUAL 的 `capacity_repair` 注入一处缩写，
扫描器必须在**已知缺陷集之外**新增一条问题才算判别成功；否则打印
`DISCRIMINATOR_DID_NOT_FIRE` 并 exit 1。实跑：新增 `NEW_ABBREVIATED_RESIDUAL … injected_by_tamper`，
exit 0（判别成功）。

**我没有做的修复及理由**：正确的修法是给生成器加一条**已声明的**替换规则再整体重跑，
而不是手改文书 —— 手改会破坏我在 §2.3 刚验证过的性质「九件恰为生成器输出」。
但这会改动九件的摘要，且哪些叙述该改是评审/Owner 的裁定，超出复核会话的权限。**留给父会话/Owner。**

---

### R33-F2（中）两件 issuer 文书实化后，**没有任何可运行的检查**把它们的字节绑住

三条独立事实叠加：

1. `work/f12/verify-issuer-candidates.mjs` 在实化后**永久变红**。它断言四个字段仍是**哨兵字符串**，
   而 `realize-issuer.mjs --write` 按设计把哨兵换成了真值。正跑现在报 16 个问题、exit 1。
   连带后果：它的 `--tamper` 反控**已失去判别力** —— 干净基线本身就红（16 个问题），
   篡改后红（18 个问题），反控证明不了任何事。
2. `realize-issuer.mjs:44-48` 用运行上面那个脚本作自守卫（`CANDIDATES_DO_NOT_VERIFY`），
   所以它自己也**永不可再运行**。
3. `check-digest-pins.mjs:60-63` 把这两个摘要列进 `DECLARED_NON_FILE`，理由写的是
   *"A remote blob digest checked against the submitted body, **not a local file**"* ——
   这句话现在是**错的**：它们恰恰就是本仓两个本地文件的 sha256（我自己 `sha256sum` 出来的）。
   而清单里 `artifacts/` 条目数为 **0**，所以清单也不覆盖它们。

结果：`context.mjs:317` 钉住的两个摘要，在本地**没有任何闸门实测**其对应文书的字节。
漂移只会在 600 秒运行中于 `:317/:318` 暴露 —— 即分配已被烧掉之后。
这正是 `build-linux-manifest.mjs:68-73` 为三个 Skill 文件写下的 R21-F3 论证所针对的失败形状，
只是那三个被补进了清单，这两个没有。

**可失败路径（我实测跑过，随后还原）**
```bash
F=artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/f12-issuer/Root7StatusIssuerPurposeMetadata.candidate.json
cp "$F" /tmp/i.bak; printf '\n' >> "$F"          # 文书漂移：sha 变成 bad8617e…，钉的是 3cb175ca…
cd scripts/phase2-qualification/control-context-verifier-root6-linux-successor && node check-digest-pins.mjs
#   -> digest pins consistent (48 literal(s) accounted for, 0 unexplained)   exit 0   ← 闸门照样全绿
cp /tmp/i.bak "$F"
```

**本轮已交付的修复**：`work/round33/verify-issuer-realized.mjs`（只读，不碰任何冻结产物）。
它在**实化后的字节**上证明：

- A 两件文书的 sha256 等于 `context.mjs` 的钉值 —— 钉值是**从 `context.mjs` 源码解析出来的**，
  不是抄进脚本的，所以控制器改钉会被跟上；
- B 相对 root5 期前身（blob `c1749399` / `3ae8bd41`）的改动集恰为声明预算，且以**实化值**表述；
- C 实化窗口等于 `root-window-validation.mjs` 实际强制的边界（同样解析源码，不抄）；
- D `authority_basis` 绑到真实合并：该 commit 存在、是双亲合并、其 committer.date 等于 `not_before`、
  approval 摘要等于**合并处**载体字节的 sha256（用 git 读，不手递）；
- E 无任何形状的哨兵残留。

```bash
node work/round33/verify-issuer-realized.mjs            # 正跑：7 项 ok，exit 0
node work/round33/verify-issuer-realized.mjs --tamper   # 反控 1：内存翻一个未声明字段 -> exit 1
# 反控 2（真实字节漂移）：按上面的 printf 追加一字节后重跑 -> PIN_MISMATCH …bad8617e527f… exit 1
```
两个反控都是从**干净的绿基线**出发触发的 —— 这正是 `verify-issuer-candidates.mjs` 丢掉的那份纪律。

**我没有动 `check-digest-pins.mjs` 的豁免措辞**：改它就要重跑三闸、重出冻结点、给出新 F12，
而九件重出文书全部钉着现 F12。为一条覆盖缺口付这个代价不该由复核会话单方面决定。**交 Owner。**

---

### R33-F3（低中）生成器作者自陈的「正式重出前置条件」未落实即已正式重出

`Window12ReissueNotes.md §7` 留了五条「请评审定」。正式重出（b634cc3）已发生，其中：

- **§7-6（明确的前置条件）**：「若正式重出还要往 `known_open` 里加条目（R31 的 E4 会加，
  本生成器没加），**先把真实上限落实**。」—— 未落实。
- **§7-7**：`known_open += R29/R30/R31` —— 未做。
  实测 `known_open` 键：v19 十三条 → v20 十四条，只多了 `R26-F1`。
- **§7-4**（E2 是否复用 CP02 哨兵名）：作者选了「复用」，**父会话推翻改成新名**。
  推翻是对的（见 §2.4），但推翻本身没在 Notes 里留裁定记录。
- **§7-5**（`APPR160v1` 是否该重出）与 **§7-8**（`Root6RegistrationAcceptance.json` 归属）：
  按生成器默认执行，无记录裁定。

顺带实测：`Root6RegistrationAcceptance.json` **不在**重出集内，且仍带作废窗口末
`2026-09-13T07:05:16Z` ×2、root6 代际 ×1。若评审认为它在 window12 仍有活效力，这是个缺口。

```bash
node -e "const fs=require('fs'),P='artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/';
for(const [t,d] of [['v19','root6-runtime-v19'],['v20','root7-runtime-v20']])
 console.log(t,Object.keys(JSON.parse(fs.readFileSync(P+d+'/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json','utf8')).known_open).join(','));"
grep -o '2026-09-13T07:05:16Z' artifacts/clued-validation/phase2-entry-preparation-20260908/root6-capacity/Root6RegistrationAcceptance.json | wc -l   # -> 2
```

**可失败路径**：若上述任一条其实已落实，`known_open` 键差集就不会只有 `R26-F1`，本条即被推翻。

---

### R33-F4（低）措辞与事实不符，两处

- `reissue-documents-window12.mjs:78` 注释写 `--selftest # runs a dry run plus **six** negative controls`，
  实为**七个**（`NEG` 表 NC1–NC7）。复现：`grep -n "six negative" work/window12-reissue/reissue-documents-window12.mjs`。
- b634cc3 提交信息写 QUAL 与 RTA「**moved** to bootstrap/root7-runtime-v20/」，实际是**复制**：
  v19 两件仍在。**这不是缺陷** —— 我核过 v17/v18/v19 全部保留，逐代留存是既有惯例；
  只是「moved」一词与树不符。复现：`ls artifacts/.../bootstrap/root6-runtime-v19/`。

---

## 2. 核准通过的项（每条附我自己的复算，不是转述）

### 2.1 F12 冻结正确

| 项 | 结果 |
|---|---|
| `sha256sum ControllerSourceManifest.candidate.json` | `73c05cada90b00915f8b352a2dac6f77bf82b44660950e7e9a1415f5cab99b35` ✔ |
| `check-digest-pins.mjs`（补齐宿主后） | `48 literal(s) accounted for, 0 unexplained`，exit 0 ✔ |
| `selftest-runtime-pins.mjs`（补齐宿主后） | `passed (0 item(s) UNPROVEN, 9 not covered)`，exit 0 ✔ |
| `build-linux-manifest.mjs --write` | `314 files {RUNTIME_DEPENDENCY:161, REPOSITORY_SOURCE:153}`；重建后 **`git status` 干净**，自 sha 不变 ✔ |

冻结点定义**我自己验过**，没有沿用陈述：`--write` 重出的清单文件其 `sha256sum` 就等于 F12，
且清单**从不列自己**（`build-linux-manifest.mjs:79`），所以「冻结点 = 清单文件 sha256」成立。

另做了一项父会话没做的独立检查：把清单 314 条逐条与本机实际字节比对 ——
**313 条吻合、0 条不符**，唯一缺席的是 `/usr/local/bin/gh`（补齐宿主前）。

### 2.2 控制器五文件的实化值，逐项对活库/合并事实核

| 值 | 声称 | 我的核实来源 | 结论 |
|---|---|---|---|
| T | `2026-09-13T05:45:14Z` | `git show -s --format=%cI f92cd46e` → `2026-09-13T13:45:14+08:00` | ✔ |
| 合并性质 | M3 已合并 | 双亲 `88fc944b` / `c8628798`，committer `GitHub <noreply@github.com>`（web-flow） | ✔ |
| 窗口末 | `2026-09-14T05:45:14Z` | T+86400000ms 计算 | ✔ |
| issuer STATUS | `3cb175ca…` | `sha256sum Root7StatusIssuerPurposeMetadata.candidate.json` | ✔ |
| issuer GATE | `209712fb…` | `sha256sum Root7GateIssuerPurposeMetadata.candidate.json` | ✔ |
| M3 approval | `e1fcd30a…` | `git show f92cd46e:…/ExplicitOwnerApprovalM3.candidate.json \| sha256sum`（**合并处**字节，非工作树） | ✔ |
| root7 代际 | `ctrgen_26769cc7…` | `context.mjs:191`；活库 `clued_control.events` 六条 GENERATION_REGISTERED 中**无**此代际 → 确未注册 | ✔ |
| `forwards:17` | 16→17 | 活库：`extra`(seq≥45) 内 forward **恰 16 个** → 旧上限 `16<16` 已达；抬到 17 恰放行一次 | ✔ 有据 |
| `root7BudgetSequence=90` | 阈值 90 | 活库：`max(sequence)=89`（1..89 连续），`BUDGET_RESERVED` 最大 **85**，序列 89 是 forward 不是 budget；`extra` 内 budget 恰 8 个 → 第 9 次分配必 ≥90 | ✔ 无历史 budget 越界 |
| 残留哨兵 | 应为 0 | `grep -rn '__F12_PENDING\|__PENDING' <控制器目录>` 无输出 | ✔ |

活库查询（只读 select，project `uscrdifznmlvczcekqpw`）：
```sql
select max(sequence), count(*) from clued_control.execution_events;
select sequence, request->>'operation' from clued_control.execution_events
 where request->>'operation' in ('BUDGET_RESERVED','EXECUTION_BINDING_FORWARD_ACCEPTED') order by sequence;
```
`BASELINE_EVENT_COUNT=44`（`context.mjs:165`），故 `extra` = seq 45..89。

R32-F2 的修复也在位：`…/commitment-signing-root6-window/signing.mjs:12` 有 `root7Generation` 常量，
`:32` 的准入表已含 `root7Generation`。

### 2.3 九件重出：确定性与逐字节可再现

- **两跑逐字节相同**（相隔 2 秒，足以暴露毫秒级墙钟戳记）：
  `diff -r runA runB` 无输出 → 父会话所修的非确定性缺陷**确已修好**（我独立复验）。
- **更强的一步（父会话未做）**：把新生成的九件与**仓库已提交**的九件逐一 `cmp` ——
  **9/9 完全相同**。即已提交文书恰为生成器在该组参数下的输出，无手改痕迹。
- **七负控全部按正确理由拒绝**（NC1 `BASE_BYTES_MISMATCH`、NC2/NC3 `DEPENDENCY_NOT_YET_PROCESSED`、
  NC4 `EXACT_STAGE_INPUTS_WOULD_FAIL`(6→5)、NC5 `STALE_WORKING_COPY_REFUSED`、
  NC6 `STATUS_MANIFEST_SCHEMA_DIGEST_DID_NOT_CHANGE`、NC7 `UNDECLARED_CHANGE`）。

```bash
node work/window12-reissue/reissue-documents-window12.mjs --selftest
node work/window12-reissue/reissue-documents-window12.mjs 2026-09-13T05:45:14Z 2026-09-14T05:45:14Z \
  73c05cada90b00915f8b352a2dac6f77bf82b44660950e7e9a1415f5cab99b35 \
  7e5df5dd2b2341fe38c7b2a86ef68542700ee878bec0c947b13d7c8311fecd2d --out /tmp/runA
# 同上 --out /tmp/runB；diff -r /tmp/runA /tmp/runB；再与仓库同名文件 cmp
```
新旧 schema 摘要我也自算过：现树 `7e5df5dd…`，`BASE_REV` 处 `510f3b90…`，与生成器常量一致。

### 2.4 RTA 内容与四哨兵

- `controller_digest` = F12（顶层与 `accepted_subject.expected_ga` 两处）✔
- `accepted_subject.expected_ga.controller_qualification_ref.sha256` = `15f2ee74…`
  = 我对**重出后** QUAL 现算的 sha256 ✔（追的是重出件，不是旧件）
- `accepted_subject.expected_ga.stage_receipt_refs` 长度 **6**，`[2]` 与 `[3]` 均为 blob `31c4574a…`
  / sha `eb25e993…` —— **未去重**，R31 附带 A 成立 ✔
- 哨兵**恰四个**，四个名字各一处 ✔

> 方法论自曝：我第一次用 `d.expected_ga.stage_receipt_refs` 取值，得到 `undefined`，
> 而 `[2]==[3]` 打出 `true` —— 那是 `undefined===undefined`。**我自己差点做出一次不可能失败的验证。**
> 正确路径是 `accepted_subject.expected_ga.…`。上面的数字取自改正后的路径。

### 2.5 哨兵类别修复（父会话自称的第 2 个修复）方向正确 —— 独立坐实

链路我是从源码追的，不是采信说明：
`root-window-validation.mjs:52-57` 的 `readControlUri` 在 root 片段返回 **`data = current.request.body`**
（GENERATION_REGISTERED 事件的请求体）；`context.mjs:311` 的 `root` 即此形状
（`:316` 用 `root.issuer_bindings`，正是 `validateRootShape(current.request.body)` 所校验的字段）。
故 `:322` 的 `canonicalDigest(root)` = **JS canonical（键排序 + 尾部 `\n`）的注册体摘要**。

而 CP01/CP02 那一类，`work/cp01/measure-root6-root-digest.sql` 写得很明确：其 `pin_this_value`
与 `whole_root_digest` 都是 **Postgres `::text` 序列化的 execution root 行**摘要。
两者**序列化器不同、主体也不同**。用现行 root6 数据实测：

| 类 | 值 |
|---|---|
| `canonicalDigest(注册体)`（`:322` 所需） | `a93bfdda74d9d693584c32ecb9e1ec963fa448b51595fbe245abfeefbb4081c5` |
| CP01 pin class（`(r-'events')‖registration_event` 的 `::text`） | `72355efd8abde02fda6401034ee39687b5ef5c54d7511d916ccd00f70a7cd6e2` |
| `sha256(r::text)` 整行 | `08a802764dc9209b102471262a734af6af7a3424a0511c523eb75a9749b9ce98` |
| `sha256(body::text)`（PG 序列化的注册体） | `21af44cb5a20921c8e77e312b193c7d1d0fe5e4b3c021fc4ba48a4282885df54` |

`a93bfdda` 与 `72355efd` 正是父会话提交信息里点名的两个类，数值确实不同。
新名 `__PENDING_ROOT7_REGISTRATION_BODY_CANONICAL_SHA256__` 对应的是前者，**方向正确、命名准确**。

> 注册体是我从活库读出后落盘的，存在抄写风险。所以这次抄写是**自校验**的：
> `signaturePayloadDigest(body)` 算出 `95973246e3ae8d33fe407960d41e47039399575c59b4f78f83882835e73d9f80`，
> 与体内自带的 `signature_binding.signed_object_sha256` 逐字符相同 —— 错一个字节这条就对不上。

---

## 3. 未复现 / 未覆盖（明写，不含糊）

- `selftest-runtime-pins.mjs` 自报 **9 项 "not covered"**（需要真实 GA、GitHub API 调用或容器操作）。
  这 9 项本轮**未被证明**，其中 `fixed_host.py arm_watchdog() PYTHON_SHA` 在 R20 已被证明可利用。
  三闸全绿**不是**对这 9 项的任何主张。
- RTA 的四个哨兵**没有任何机械实化入口**（全库 grep：只有生成器写它们、Notes 提它们、
  M3 载体与 `validate-m3-candidate.mjs` 声明其中 GATE issuer 那一对）。这正是 R32-F6 的形状
  —— 父会话刚为 issuer 两件补上 `realize-issuer.mjs`，RTA 这四个还没有对应物。
  它们要到 root7 注册与 S24 之后才能取值，**在本窗口是合理的开口**，但下一会话若靠手替就是 R32-F6 复发。
  顺带一提：GATE issuer 的 uri 与 sha 其实**今天就可从字节算出**（sha = `209712fb…`；
  uri 的 blob sha1 由 `blobSha(bytes)` 决定），待定的只是「合并后该 blob 确实存在」。
- 本轮**未做**：任何库写、`append_event`、预留、600 秒、开 PR、合并；未改
  `scripts/phase2-qualification/` 下任何冻结产物（`build-linux-manifest --write` 重建后
  `git status` 干净，字节未变）。
- 宿主改动：装了 `apps/clued-cloud/node_modules` 与 `/usr/local/bin/gh`。两者都不进 git；
  `package-lock.json` 被 npm 改动过，已 `git checkout --` 还原。

---

## 4. 本轮交付物

| 文件 | 作用 |
|---|---|
| `work/round33/Round33Review.md` | 本报告 |
| `work/round33/verify-issuer-realized.mjs` | 修复 R33-F2：实化后 issuer 两件的可运行检查（正跑绿；两个反控从绿基线真红） |
| `work/round33/scan-superseded-abbreviations.mjs` | 修复 R33-F1 的隐形性：缩写残留清单钉死 + 叙述/字段矛盾检测；反控对**已知缺陷集做差**，避免重蹈 `verify-issuer-candidates.mjs` 的覆辙 |

`scan-superseded-abbreviations.mjs` 正跑目前 **exit 1**，因为 F1a 尚未修复 —— 这是正确行为，
不是工具坏了。它同时打印 `KNOWN OPEN (R33-F1a)` 与 `NEW`，F1a 修好后正跑即转绿。
