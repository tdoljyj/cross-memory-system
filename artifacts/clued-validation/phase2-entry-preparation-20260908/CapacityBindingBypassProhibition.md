# 禁止：通过解除容量绑定绕过容量校验

**状态：`BINDING_PROHIBITION_RECORDED_ON_A_PREMISE_LATER_FOUND_FALSE`。**

> **2026-09-12 更正（继任评估者第二轮 C1）。** 本文件的前提是错的。`checkCapacityAdministration` 的早退分支
> **在活路径上不可达**：其唯一调用者 `checkBoundedSeries` 未导出，而调用链上 `context.mjs:210` 以
> `need(Object.hasOwn(s,'capacity_materials'),'NEW_CAPACITY_CONSUMER_REQUIRES_REAL_SUPPLEMENT')` fail-closed，
> `:211` 独立再要求 `same(s.capacity_delta,capacityDelta)`，`:243` 再检 `capacity_materials!==null`。
> 删掉那两个键不会静默跳过容量治理，会直接抛错。
>
> 本文件按评审者建议**保留而非删除**：禁令本身无害，实施方不采取该路径的承诺仍然有效。但它所描述的
> 「最省力的绕过路径」并不存在，读者不应据此认为容量治理曾处于可被静默移除的状态。
>
> 实施方第一轮全盘采纳了该发现、未加验证即标为「源码直接确认」——确认的只是那几行存在，
> 没有确认从它们推出的**可达性结论**。

由实施方记录，回应继任独立评估者（会话 `session_018nf6mQ5CQuMFadoJ9WRZCN`）在其 F5 项中的发现。

本文件不接受任何对象、不签发任何资格。它记录一条**实施方对自身的禁令**，以及为什么这条禁令必须写下来而不是默会。

## 这条路径是什么

`context.mjs` 中 `checkCapacityAdministration` 的首两行：

```js
const s = runtime?.accepted_subject, has = s && Object.hasOwn(s, 'capacity_materials');
if (!has) { need(!Object.hasOwn(s ?? {}, 'capacity_delta') && capacity_materials === null,
                 'CAPACITY_PARTIAL_BINDING_FORBIDDEN'); return null; }
need(same(s.capacity_delta, capacityDelta) && ... );
```

若运行时验收的 `accepted_subject` **同时**不含 `capacity_materials` 与 `capacity_delta` 两个键，函数在第二行 `return null`，其后全部检查不再执行：

- `same(s.capacity_delta, capacityDelta)` —— 即 133 与 131 的比对
- 容量适用性的 `controller_digest` 绑定（`CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE`）
- `CAPACITY_APPROVAL_CURRENT_ROOT5_TIME`
- Owner 签署的容量批准与独立适用性的全部实质校验

评估者另指出：`repairAccepted` 亦会因此把 043 那次 BLOCKED 从「须有经批准的容量修复」降级到通用路径。

## 为什么必须明文禁止

当前的真实阻塞（F1）是：控制器把 `capacityDelta.source_refs_maximum` 改成 133，而该常量在**三处**被逐字节比对，三处全是 131——

1. Owner 签署的容量批准 `f3afb108…`
2. 独立容量适用性 `cc3db45b…`
3. 运行时验收自身的 `accepted_subject.capacity_delta`（**实施方此前漏记的第三处**）

解除它的正路需要：一次新的 Owner 签署批准，加一次新的独立验收。

而 F5 这条路只需要**删掉两个键**。

两者成本相差悬殊，而结果的差别不体现在运行是否成功上——**恰恰相反，走 F5 运行会成功**。差别只体现在产出的凭据是否真的携带容量授权。这正是最容易被"为了把任务推完"而合理化的一步，因此它必须被写下来。

## 禁令

实施方在本轮及后续任何一轮中，**不得**：

- 从运行时验收的 `accepted_subject` 中删除 `capacity_materials` 或 `capacity_delta`
- 以任何其他方式使 `checkCapacityAdministration` 走上 `return null` 分支
- 以「容量校验在本轮不适用」为由构造等效效果

若容量绑定确因某种正当理由不再适用，该判断须由独立评估者作出并出具，不得由实施方自行认定。

## 唯一可接受的解除方式

1. 继任独立评估者出具**容量适用性继任文档**，钉住 root6 控制器摘要与 `source_refs_maximum: 133`
2. Owner 签署新的**容量批准**，其 `capacity_delta` 与控制器常量逐字节一致
3. 实施方重签运行时验收，使其 `accepted_subject.capacity_delta` 与上述二者一致，并把 `capacity_materials` 的两个引用指向新文档

三者缺一，本轮不得进入最后 600 秒。

## 记录

发现者：继任独立评估者，会话 `session_018nf6mQ5CQuMFadoJ9WRZCN`，依据 Owner 决定合并提交 `a573ca93e094bc9a4a8dccc23c1e165b6b368ff4`。
实施方独立复核：已直接读取 `context.mjs` 源码确认该早退分支存在且如所述。
实施方未采取该路径，且以本文件承诺不采取。
