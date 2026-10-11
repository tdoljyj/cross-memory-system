/** Owner-approved successor: a single, explicit consent for all connection
 * capabilities. Never substitute this version for the older read-only or
 * scope-upgrade disclosures: they remain valid for their narrower actions. */
export const MASTER_DISCLOSURE_VERSION = "clued.storage-master-disclosure/1";
export const MASTER_RECONNECT_CONFIRMATION = "clued.storage-owner-confirmation/3";

export const renderMasterDisclosure = (root: string) =>
  `开启总开关后，你授权的 Agent 可以在「${root}」内查看文件名和目录、读取文件内容、按内容搜索、新建文件与目录、上传支持的文件，并纳管你自己拥有的已有文件和文件夹。纳管后可以改名、移动、覆盖文本内容、移入回收站和恢复，也可以移动整个文件夹。已有对象仍须先纳管，每次操作仍须通过目录和任务检查，并留下回执。\n` +
  "读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。覆盖前的内容按原规则保留为 Drive 版本；回收站不立即永久删除，但 Google 会在 30 天后自动永久删除。批量回收站确认和每小时额度继续生效。\n" +
  "Google 授权页会请求“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”。Clued 服务端将操作限制在这个目录内；Google 授权本身覆盖整个云端硬盘。只有 Google 实际授予所需范围、全部权限生效后，总开关才显示全开。\n" +
  "关闭总开关会停止此连接的全部 Agent 文件操作，不删除文件，也不撤回 Google 授权。已经完成的读取和改动无法收回；尚未结束的文件任务需先核对结束。调整细项后，总开关会按实际权限显示部分开启。";

export const MASTER_OFF_DISCLOSURE =
  "关闭总开关，停止此连接的全部 Agent 文件操作？目录查看、正文读取、搜索、新建、上传、纳管、修改、移动和回收站操作都会停止；不会删除文件或断开 Google。已经返回的内容和已完成的改动无法收回；尚未结束的任务需先核对结束。";
