# 节点 CI 当前连接合同

适用范围为 Windows 常驻节点。安装身份来自受安装回执约束的 installation.json 与 acceptance.json。当前连接只确定一次入口进程使用的连接编号和 CI 令牌指纹。

## 磁盘表示

控制入口在 CI 根目录的 `secrets\ci-admission.token` 旁读取 `ci-admission.connection.json`。安装回执位于同一 CI 根目录的 `resident\install`。升级和心跳令牌使用 `resident\secrets` 下各自的位置。

记录采用 UTF-8 紧凑 JSON，键以序数排序，无文件头签名、尾随换行或重复键。控制账号只读，SYSTEM 与 Administrators 管理，companion 无读取权。

| 字段 | 约束 |
|---|---|
| `contract` | 固定为 `clued.independent-ci.ci-connection/1` |
| `baseNodeIdentitySha256` | 按已安装并经核验的两份记录重算的节点身份摘要 |
| `bindingId` | 服务端换绑结果中的小写 UUID |
| `bindingGeneration` | 服务端连接代次，JS 可精确表示的正整数 |
| `rebindReceiptId` | 同一换绑结果的回执，小写 UUID |
| `tokenPinSha256` | 对固定域串 `clued.independent-ci.ci-binding-pin/1`、一个零字节和新令牌的连续字节计算 SHA-256，使用小写十六进制 |
| `previousSha256` | 前一份规范记录的字节摘要，首次激活为 JSON null |
| `activatedAt` | UTC 时间，以 `yyyy-MM-ddTHH:mm:ss.fffZ` 写入 |

## 入口与自检

确认记录缺失时，采用安装记录的编号和指纹，代次为空。存在记录时，先核路径、文件权限、规范字节和安装身份，再使用其中的编号和指纹。无效记录返回 `CI_CONNECTION_RECORD_REFUSED`。当前指纹与盘上令牌不符返回 `ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED`。入口在这两项检查后才使用凭据，通过同一进程内的准入端口复用核验结果。

`ciPrincipalRoleRef` 与 `ciPrincipalQualificationRef` 保留首次授权的决定编号。服务端决定新连接此刻的角色与资格。自检的 `node-identity` 关联安装身份，`node-secrets-receipt` 核对原始回执，`current-ci-connection` 核对实际令牌并显示当前编号、代次及换绑回执。升级及回滚仍以安装身份摘要核验；已有当前连接的节点进入首装或重装时返回 `CI_CONNECTION_REINSTALL_BASELINE_REQUIRED`。

换绑后的节点使用 v2 控制、v2 one-shot 和 bridge v4。旧版 v1 控制、bridge v2 和 v3 在 Windows 密钥读取时都没有传入控制账号 SID，因而会在指纹比较之前收到 `secret_file_boundary_unconfirmed`。

## 自动续期

常驻服务每天向 Broker 投递一次 CI 与升级连接的续期请求，不自行判断窗口和当班；这两件事只由 Broker 的新鲜签名探询判断。等待让班、网关或回包未确认（`RENEW_GATEWAY_UNAVAILABLE`、`RENEW_RESPONSE_UNAVAILABLE`、`RENEW_INTERRUPTED`、`RENEW_UNAVAILABLE`）及无合格接班者时每小时重投，`RENEW_BUSY` 两分钟后重投，待批按服务端给出的间隔重投。投出的请求只认它自己的请求号，有结论前不投新请求，常驻重启后继续等同一请求号。采纳与否不看时间：状态里记着的还是这个请求号时，任何一轮读到它的回包都按正常回包处理（含让班、确认待命；很晚才读到的让班即使生效时刻已过，也立即交出接单资格），回包里的结论归投出请求的那一代。两分钟未读到时状态显示 `RENEW_RESPONSE_WAITING`（不发失败通知）。等满一小时（按常驻自己的时钟）放弃前再读一次回包文件，仍读不到才记 `RENEW_RESPONSE_UNAVAILABLE`（归当前代，每小时复核）；放弃后旧请求号仍留在状态里，直到投出新请求换成新号，期间读到它的回包照常采纳（不挡投递）；换成新请求号之后旧号的回包不再采纳。“换号”以读回的新请求文件正文完整为准：新号先记为准备，文件没建成、正文为空或只写了一半（写失败或写到一半退出）都按未投出处理，旧号照旧可采纳，残件不再复用、下次投递另取新号；正文完整的新号重启后接上，不丢。CI 更换前核对本机 runner 空闲、账本无未结项和服务端已排空且不当班的应答。旧连接到期导致本机角色不确定时仍可发起探询和排空确认。当班节点在服务端返回的续期窗口内请求计划内让班，升级连接独立巡检。

常驻向原 Broker 请求目录写入仅含 `kind` 的 JSON。取值为 `ci` 或 `upgrade`。实际执行者是已安装的 LocalSystem Broker。它静默打开登记时创建的不可导出 P-256 机器密钥，先查 TPM，再查软件提供程序。每次签名均指定原生静默标志，并用公钥验证结果。签名请求发往 `/v1/ci/node/renew`，携带旧令牌 SHA-256。探询和让班的 `new_token_hash` 为 null。探询返回的 `renewal_window_opens_at` 已到，且符合续期条件时，Broker 在机内生成新令牌，续期请求只传新令牌哈希。

Broker 在发送写请求前持久化恢复记录，限定 SYSTEM 与内置 Administrators 可读。Broker 核对节点、身份指纹、前后连接和代次，并以新凭据哈希独立核验后放置新文件。正常提交应答和 CI 的 Self 提供回执编号。两类连接都先替换记录，再替换令牌，各文件分别原子改名。已提交的事务只向前恢复。读回不符或删事务失败时，保留暂存证明，下次核验新哈希并补齐文件。目标读回成功后删除事务文件。

升级连接的公开记录为 `resident/install/resident-upgrade.connection.json`，SYSTEM 写入，包含安装身份、当前连接编号、代次、域分隔指纹与回执编号。若提交应答丢失，D1 对新哈希的探询可证实连接和代次，但没有返回升级回执编号，此时记录的 `receiptId` 为 null。重装 prepare 从这份公开记录取指纹并钉入 launcher；记录缺失才使用原安装回执。launcher 携带前和复制后分别核对指纹。旧版人工输入脚本已从新代次移除。

### 日常自检与首次恢复

在状态的 `versions.renewal` 查看两类连接的编号、到期时间、窗口开启时刻、拒绝码及签名权限检查。SYSTEM 以服务自身身份对固定挑战签名并验签。控制账号在已核身份的角色探测中，常驻和陪伴账号在各自进程身份下，分别尝试静默打开两个 KSP；对应 SYSTEM 实际使用的提供程序必须明确拒绝。任一身份成功打开密钥、探测结果未知或缺少观测都会使检查失败。当班期间控制账号沿用最近一次同身份的拒绝观测，其余观测须在三十分钟内。陪伴账号还对 CI 的令牌和当前记录分别尝试只读打开，文件缺失与访问被拒均符合预期。续期异常单独产生 `renewal-failed` 通知。程序只保留判定，不输出文件内容。

两类连接首次探询都将 `project_id`、`node_id`、`old_binding_id`、`generation` 与 `new_token_hash` 签为 JSON null。服务端用登记指纹和旧令牌证明确认归属，返回项目、节点、连接和代次。后续签名绑定这些编号。CI 连接自查沿用安装作用域，包括旧安装的 `global`。

在服务端返回的续期窗口内，签名探询表明本机当班时，Broker 用原 CI 证明签入 `action=yield`，由服务端选接班者。收到与原连接匹配的让班回执后，常驻暂停开新批，立即安排角色探针。等待中每小时重投巡检，接班生效后仍须由角色探针确认待命，且本机子进程空闲、账本无未结任务。Broker 给出一次性确认编号，常驻在这些条件满足时才以该编号再投同一份 `{"kind":"ci"}`。Broker 重新探询并校验连接、代次和旧令牌证明后才创建续期事务。

无合格接班者时，状态保留 `RENEW_HANDOVER_NO_CANDIDATE`、原连接编号及到期时刻。当班继续工作，一小时后重试。成功续期的节点留在待命，后续当班仍由现有角色机制决定。

重启时 Broker 先用事务中的新哈希查后继连接。核对项目、节点、指纹、连接、下一代次和到期时刻后，CI 再通过 Self 核回执，升级类用绑定到该代次的签名探询复核。若新证明尚未登记，Broker 查旧连接。未提交的 CI 事务须重新经过本地排空确认才能继续。只有同一笔持久化换发请求收到 HTTP 409、布尔值 `renewed:false` 和已安装代次机器合同 `clear_intent.codes` 内的拒绝码，才按拒绝清事务。旧绑定已有续期记录时，重放原换发证明可区分 `RENEW_SUPERSEDED` 与 `RENEW_REPLACEMENT_UNUSABLE`，后者保留事务。探询和让班的拒绝均保留事务。

HTTP 202 携带审批编号和重试秒数，常驻保存两项并按服务端间隔复查。HTTP 503 及传输未确认以 `RENEW_GATEWAY_UNAVAILABLE` 按小时重试。来源缺失的 HTTP 403 记录为 `RENEW_SOURCE_REQUIRED`。该代次通用包以 D1c 已迁移、已部署为接受前提。

演练机使用登记流程创建专用密钥并运行已安装服务后，把同一轮的公开观测复制到演练证据目录。离线夹具 `test/renewal-drill.mjs` 接收该目录，核对身份、提供程序、时效、陪伴读拒绝和 SYSTEM 网关探询。令牌文件必须是陪伴“拒绝访问”；连接记录以管理员侧实读为准，存在则陪伴必须“拒绝访问”，不存在则必须报“不存在”，对不上即失败。首装时记录不存在，记录的拒绝访问登记为未验到（`record.denial`），其真机证据是已激活节点每天的 keyCheck。

| 证据文件 | 来宾中的来源 |
|---|---|
| `profile.json` | 已接受节点档案中的 `controllerSid` 和 `ownerSid` |
| `system.json` | `resident/broker/renew-key.json` |
| `resident.json` | `resident/state/renew-key-resident.json` |
| `controller.json` | `state/v2/receipts/renew-key-controller.json` |
| `companion.json` | `resident/mailbox/responses/renew-key.json` |
| `probe.json` | `resident/broker/renew-ci.json` 或 `renew-upgrade.json` |
| `record.json` | 来宾管理员对 `secrets/ci-admission.connection.json` 的实读，只记 `PRESENT` 或 `ABSENT`，不读内容 |

路径相对于来宾的 CI 根目录。控制账号的观测来自实际第 11 阶段服务令牌。正式包从 `windows/SwapBroker.cs` 生成 resident 清单项及 `bin/SwapBroker.cs` 编译槽。Broker 读取当前代次指针所钉的安装回执，并核对运行中的可执行文件、清单和两处源码摘要后才执行续期。
