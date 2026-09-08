# 首次根登记的精确审查输入

**UNISSUED_FIRST_ROOT_REVIEW_SUBJECT / NO_DATABASE_WRITE / NO_GATE**。`RootReviewSubject.json` 是待登记正文的完整审查subject，刻意不含必须在后续产生的独评接受引用与本对象签名绑定。它不是已登记实例；正文status描述将来事务成功后拟登记状态。所有已知值直接来自实际文件和一次真实非生产只读观察，没有样例签名、虚构epoch或默认N/A。

原Root登记范围subject `e4ab25ec…` 已由既有SQL固定，不能改成此次具体Root正文的review subject摘要；两者在 `AcceptedBindingInputs.json` 分别记录。实际原Owner批准、tdoljyj/web-flow签名来源、已接受并应用Schema/Manifest、Protocol算法/URI接受、已部署空Store各自以精确字节绑定；`SourceBindings.json`列出路径、SHA256、Git blob与URI。Git blob URI是对应精确内容的地址，实际未远端持久化的本地已接受对象必须先发布并回读，本文不假称已远端存在。

三个issuer用途STATUS/GATE_AUTHORIZATION/GATE_RESULT使用不同用途条目和同一明确受限Audience；不包括Promotion。`qualification_ref`引用的78c1…记录只证明真实Owner/signing identity和已批准限定目的，**本身不是GA/GRR用途资格**。本次Root独评决定须逐项接受用途/Audience/算法/config及精确review_subject_sha256，最终签名payload必须加入该实际决定引用。Root注册本身仍不开放GA；Profile、controller、host和每Gate其他前置照旧。算法/config引用988cdf…已实际存在的Protocol限定接受，不能以普通service_role替代它。

2026-09-08T12:12:14.380995Z独立实际SQL读到private Store三个计数均0，作为首次完整空prefix `[]` 和空撤回集合来源；其SHA按已接受候选规范化计算，没有填一个无来源epoch。not_before/as_of取真实DB观察时间，expiry继承原Owner截止2026-09-09T09:28:59Z。必须在真实事务前重新读取Owner当前状态、同一空prefix和窗口，不能把本次点时观察永久当当前。只读metadata也确认无业务四层epoch字段；另结合原逐层语义映射与独评S06 L3012适用性裁定，RootSet不承载那组业务Vector，Profile和实际凭据规则不变。

`accepted-binding.sql` 是单行参数化INSERT，只接受完整实际参数，无占位默认、无ON CONFLICT覆盖。`AcceptedBindingInputs.json`已经给齐15个可确定值，剩余 `registration_acceptance_sha256` 与 `signature_evidence_sha256` 必须来自对这个实际subject的后续接受/签名；不能借用PR25对旧批准文件的签名。主控应在一个事务中插入该绑定、读取其实际配置摘要并追加首次GENERATION_REGISTERED事件；任一步失败回滚整个事务，不能留下有配置无根的半成品。当前文件没有数据库连接或执行入口。

最小顺序：独评本review subject及逐用途准入 → 将真实接受引用加入subject → 计算signaturePayloadDigest（仅排除signature_binding）→ 现有Owner签名发布该精确payload承诺并真实验签 → 组装signature_binding及两项真实配置摘要 → 新鲜源核对后由主控同一事务登记 → 独立实际回读。独评subject摘要排除独评引用和签名绑定，故不会形成接受自引用；签名覆盖真实独评引用。Git仅承载接受/签名承诺等证据，live RootSet只进现有非生产Control Evidence Store。

生成命令 `node prepare.mjs`；它逐一核对8份真实源字节并验证URI映射与实际Manifest一致，仅写本目录的准备文件。`node --test subject.test.mjs` 只验证此实际review subject在两项后续绑定之前的完整结构、真实空prefix、摘要与双subject区别，不写DB、不签根、不把局部测试称PQUAL/R11。
