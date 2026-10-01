/** StorageNormalUse.v0.1 §8.1 step 1 and §8.2: the onboarding disclosure
 * `clued.storage-onboard-disclosure/1`. The page shows exactly this text and
 * the Worker renders it again from the same inputs to compute the SHA-256 the
 * database stores with the attempt and in the Owner's Decision. Any change to
 * the text needs a new disclosure version (database first). No imports: the
 * page test loads this module in isolation.
 */
export const ONBOARD_DISCLOSURE_VERSION = "clued.storage-onboard-disclosure/1";
export const ONBOARD_DEFAULT_ROOT_NAME = "Clued_资料中心";
export const ONBOARD_DEFAULT_TRACKS: readonly string[] = Object.freeze(["资料", "项目", "归档"]);

export type OnboardRootChoice = { mode: "new"; name: string } | { mode: "picked"; name: string; folder_id: string };
export type OnboardChoice = {
  root: OnboardRootChoice;
  tracks: readonly string[];
  normal_use: boolean;
  default_refresh: boolean;
};

const control = /[\u0000-\u001f\u007f]/;
/** Root folder name: 1-120 characters, trimmed, no control characters. */
export function onboardRootNameValid(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 120 && value === value.trim() && !control.test(value);
}
/** Track names: the 104436 qualification rule; 1-32 distinct names. */
export function onboardTracksValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 32 && new Set(value).size === value.length &&
    value.every(track => typeof track === "string" && track.length >= 1 && track.length <= 160 && track === track.trim() &&
      !/[/\\]/.test(track) && !control.test(track) && ![".", "..", "00_从这里开始"].includes(track));
}
export function onboardFolderIdValid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
export function onboardChoiceValid(value: unknown): value is OnboardChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choice = value as Record<string, unknown>, root = choice.root as Record<string, unknown> | undefined;
  if (Object.keys(choice).sort().join(",") !== "default_refresh,normal_use,root,tracks" ||
    typeof choice.normal_use !== "boolean" || typeof choice.default_refresh !== "boolean" || !onboardTracksValid(choice.tracks) ||
    !root || typeof root !== "object" || Array.isArray(root) || !onboardRootNameValid(root.name)) return false;
  if (root.mode === "new") return Object.keys(root).sort().join(",") === "mode,name";
  return root.mode === "picked" && Object.keys(root).sort().join(",") === "folder_id,mode,name" && onboardFolderIdValid(root.folder_id);
}

/** clued.storage-normal-use-disclosure/1 (§8.2), with the actual root name. */
export const normalUseDisclosureText = (root: string) =>
  `开启后，你授权的 Agent 可以读取「${root}」内的全部文件，包括你手动上传的文件：文本、文档、表格、PDF 的文字，图片内容，压缩包的目录和其中单个文件；其他文件可通过几分钟内有效的下载链接取回原始内容。视频和音频只读取时长、分辨率、大小等信息。Agent 还可以按内容搜索文件，并在该目录中新建图片、PDF、压缩包等文件（每个最多 20 MB），不会覆盖或删除已有文件；你手动上传的文件 Agent 不能改名、移动或删除。\n` +
  "读取到的内容会发送给该 Agent 所用的模型服务，已经返回的内容无法收回。\n" +
  "Google 页面会显示“查看你 Google 云端硬盘中的所有文件”。Clued 服务端只允许访问所选目录，这个限制由 Clued 保证，不由 Google 保证。\n" +
  "默认每小时额度：读取 256 MB、上传 256 MB。关闭“正常使用”会立即停止读正文、按内容搜索和上传，但不会收回 Google 授权；“撤回全部文件读取授权”会断开该 Google 账号在 Clued 中的所有连接。";

/** The full text the Owner confirms with “确认并连接 Google Drive” (§8.1 step 1). */
export function renderOnboardDisclosure(choice: OnboardChoice): string {
  const name = choice.root.name, tracks = choice.tracks.map(track => `「${track}」`).join("");
  return `点击“确认并连接 Google Drive”即表示你确认：Clued 使用你 Google 云端硬盘中的「${name}」作为资料根目录` +
    (choice.root.mode === "new" ? `，在“我的云端硬盘”下新建该目录及子目录${tracks}` : `，并在该目录下新建子目录${tracks}`) +
    "，并以你的名义记录这一决定；你授权的 Agent 可以在该目录内查看目录结构、新建文件和子目录。" +
    (choice.normal_use ? "\n" + normalUseDisclosureText(name) + "\n" : "") +
    (choice.default_refresh ? "Clued 会在后台自动续期 Google 授权，直到你关闭或断开连接。" : "") +
    "你可以随时在本页关闭或断开连接。";
}
