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

## 在节点上激活

`windows/replace-ci-token.ps1` 的普通窗口计划绑定节点名、安装身份摘要、目标路径、目标 ACL 与合同版本。生产令牌经 Windows PowerShell 5.1 凭据窗口输入。演练机可用 `-TokenFile` 提供安装目录外的普通文件，读取该文件的独占句柄关闭时即删除它。

应用时先核 Owner 身份、计划与令牌指纹，再向安装记录指定的 `clued_ci_connection_self_v1` 发送令牌哈希及准入作用域。服务端的 `binding_id`、`node.binding_generation`、`node.rebind_receipt_id` 是记录三项的来源。工具用本机登记时的 Windows CNG 身份公钥核对 `node.identity_fingerprint`，缺少原密钥或返回外机指纹时停止。

通过全部核验后，先持久化受相同 ACL 保护的临时事务记录，再准备两份 `.new` 文件，依次原子替换记录、令牌。两文件读回成功后删除临时事务记录。中断后重新提供同一枚令牌。两文件已提交而读回尚未完成时，只完成原事务的本地读回。普通重复使用当前令牌会在联网前拒绝。

HTTP 401/403 返回 `CI_CONNECTION_TOKEN_REFUSED`。缺少函数或应答形状不符返回 `CI_CONNECTION_SELF_UNAVAILABLE`。没有节点或换绑回执返回 `CI_CONNECTION_NOT_REBOUND`。指纹属于其他节点返回 `CI_CONNECTION_OTHER_NODE`。新激活的代次未递增返回 `CI_CONNECTION_GENERATION_NOT_NEWER`。这些拒绝均发生在目标目录写入前。[Owner 操作说明](../rollout/fleet/README.md#更换节点的-ci-连接)
