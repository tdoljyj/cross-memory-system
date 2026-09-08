# CA01–CA03 最小检查结果

状态：**ENGINEERING_PREPARATION_ONLY**。实际运行 **11/11 通过，0 失败、0 跳过**；未修改业务实现或 package.json。

检查源码位于 [test-phase2-change-applicability.mjs](../../../../apps/clued-cloud/scripts/test-phase2-change-applicability.mjs)。复用现有 Node test、esbuild、TypeScript；在 `apps/clued-cloud` 执行：

```text
node --test scripts/test-phase2-change-applicability.mjs
```

| 检查 | 实际范围 | 结果 |
| --- | --- | --- |
| CA01 | 4 个 bootstrap issuer 分支，以及 context 开关不改变旧工具元数据 | 5/5 |
| CA02 | 账户 REST 的权限拒绝为403；真实 JWT 错误保持401并阻止后续项目 RPC | 2/2 |
| CA03 | 真实授权页面路由：request_id、双 ID 优先级、旧 authorization_id、缺失 ID | 4/4 |

CA03 执行真实页面/路由/旧授权组件代码，复用既有测试的轻量 hook 方法；delegated 组件与共享认证服务在边界替身处观察，不重复其既有内部测试，不冒充浏览器验收。

[结构化结果](TargetedChecks.json) 保存精确命令、源码摘要、逐项结果与执行边界。`f3d0066197c06220d34f825dd59c74bcf968cdfd` 和 `7d435110a3b2a05fa1773f2609932094550ab94e` 的整个应用目录无提交差异；执行涉及的源码也逐字节匹配两个提交与工作树。

首次受限环境在 esbuild 解析源码时被文件权限阻止，尚未执行用例；同一脚本在获准宿主环境运行成功。没有重跑完整 CI、访问正式业务数据、签发资格或接受。CA04 实际浏览器证据仍由主控处理。
