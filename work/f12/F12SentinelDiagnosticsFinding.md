# F12-N1：哨兵设计会让第二道闸吐出四条「说不清原因」的失败（自查发现，已定位、已量化、已给缓解）

**这是我对自己上一条声明的反证。** 我在 6bbfeac 的提交说明里写「未实化的树不可能静默通过」——
那句仍然成立。但我当时**只测了第一道闸**（check-digest-pins），没测第二道
（selftest-runtime-pins），却把结论说成了整体性质。补测结果如下。

## 实测（可复现）

未实化（哨兵在位）树上直接跑 `node selftest-runtime-pins.mjs`：**6 条失败**。

| 条数 | 内容 | 性质 |
|---|---|---|
| 2 | `census: context.mjs carries 20 digest literal(s), CENSUS says 22`；`census: 71 … table sums to 73` | **设计内**：说得清，直指哨兵 |
| 4 | `prepare(): platform gate: … the sandbox did not settle with the injected digest as its only complaint`；`prepare(): platform gate / /usr/bin/docker identity / host-effect.mjs -> python3.11 bytes: the sandbox did not return to a consistent state` | **说不清原因** |

那四条属于变异-复原型探针：它们把树复制进沙箱、注入一处变异、要求「注入的摘要是**唯一**抱怨」。
哨兵让沙箱基线本身就不干净，探针于是无法区分「我注入的变异」与「这棵树本来就不满」。

## 归因实验（同树同位置，只改哨兵——不是拿别的树对比）

先试过 `git worktree` 拉 7f511fa 对比，**否掉了**：worktree 里报的是另一条失败
（`pristine run does not reach the controller`），环境不同，比较不干净。改做决定性实验：
在同一棵树上用 realize-f12.mjs 填入形状合法的临时值（T=2026-09-14T00:00:00Z、
issuer 摘要 1111…/2222…），重跑两道闸：

- `check-digest-pins`：**digest pins consistent (48 literal(s) accounted for, 0 unexplained)**，exit 0
- `selftest-runtime-pins`：**runtime pin self-test passed (0 UNPROVEN, 9 not covered)**，exit 0

随后 `git checkout --` 复原，哨兵计数回到 2/2/1。
**结论：那四条由哨兵引起，非既有缺陷。**

## 缓解（已验证，非承诺）

`build-linux-manifest.mjs:31` 以 `execFileSync` 先跑 check-digest-pins（非零退出即抛出），
`:35` 才是自检 —— 真实冻结流程**在到达自检之前就中止**，看到的是清晰的普查短缺信息。
所以该缺陷只影响「绕过清单构建、直接单跑自检」的人。

## 未做的事（留给 Round 32 裁定，我不自行扩大改动）

没有去改 selftest-runtime-pins 让它识别哨兵并报 `unproven`。理由：那是控制器源文件，
一改就动 F12 冻结点，而缓解已使真实路径不受影响；是否值得为诊断质量付一次冻结点代价，
应由评审裁定，不由我顺手决定。**本条须写入 F12 冻结记录，不得只留在这里。**
