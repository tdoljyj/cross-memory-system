import type { Domain, Locale } from "./imprint-model";

export type SuggestionSource = {
  /** UTF-16 offsets into the unchanged input, as used by String.slice. */
  start: number;
  end: number;
  text: string;
};
type Candidate = {
  status: "candidate";
  authoritative: false;
  source: SuggestionSource;
  rule_id: string;
  reason: string;
};
export type DomainSuggestion = Candidate & { domain: Domain };
export type FragmentSuggestion = Candidate & { kind: "task" | "decision" };
export type SuggestionOptions = {
  /** This is provenance supplied by the caller, never inferred from the body. */
  sourceKind?: "owner_text" | "external_material" | "unknown";
  locale?: Locale;
  /** Explicitly requested mixed-content review; never used by automatic domains. */
  mixedContent?: boolean;
};
export type ImprintSuggestions = {
  status: "candidate";
  authoritative: false;
  execution_authorization: "NOT_GRANTED";
  rules_version: "imprint-explicit-local.v2";
  domains: DomainSuggestion[];
  fragments: FragmentSuggestion[];
};

// These intentionally narrow rules identify explicit statements, not topics.
// Language, tools, document format and the mere presence of a keyword are not
// evidence of the owner's purpose. Unknown authorship never yields a commitment.
const PURPOSE_DOMAINS: readonly { domain: Domain; zh: RegExp; en: RegExp }[] = [
  { domain: "daily", zh: /^(?:我的)?(?:日常生活|家庭生活|家务安排|家庭开支|个人开支|家庭预算|个人预算|就医安排|搬家安排)(?:$|[^A-Za-z])/u,
    en: /^(?:my )?(?:daily life|household planning|household budget|personal budget|family life|medical appointments|moving home)\b/i },
  { domain: "work", zh: /^(?:我的)?工作(?:$|中|上的|职责|项目|汇报|会议|交付|准备|用途|使用|需要)/u,
    en: /^(?:my )?(?:work|job duties|work meetings|work delivery)\b/i },
  { domain: "learning", zh: /^(?:我的)?(?:学习|课程学习|课程复习|考试复习|备考)/u,
    en: /^(?:my )?(?:learning|course study|course revision|exam preparation)\b/i },
  { domain: "creation", zh: /^(?:我的)?(?:创作|小说写作|剧本写作|故事写作|艺术创作)/u,
    en: /^(?:my )?(?:creative writing|artistic creation|creating (?:stories|art|fiction|a novel)|writing (?:fiction|a novel|a script))\b/i },
  { domain: "interest", zh: /^(?:我的)?(?:兴趣爱好|兴趣探索|兴趣研究|业余爱好|爱好|休闲娱乐)/u,
    en: /^(?:my )?(?:hobbies|hobby|leisure|personal interests)\b/i },
];
// Recognize an actual use/activity, not a material's language or file format.
// These also work without a separate "purpose:" field. Uncertain/reported/code
// exclusions below still apply before any domain is adopted.
const ACTIVITY_PREFIX = "(?:我)?(?:今天|明天|本周|下周)?(?:正在|在|计划|会|将|准备|继续)?";
const CLIENT_DESIGN = /^(?:客户|公司|团队)(?:的)?\s*(?:Logo|标志|品牌视觉|海报|插画|页面|界面)\s*(?:设计(?:方案|稿件|稿)?|方案|稿件)(?:$|[：:，,、。.!?\s])/iu;
const ACTIVITY_CONTEXT_BLOCK = /(?:考虑|想要|只是|不是|并非|不用于|不再)|\b(?:not|never|no longer)\b/iu;
const ACTIVITY_MATERIAL_BLOCK = /(?:教程|教材|指南|案例|简介|介绍|是什么|如何)|\b(?:tutorial|textbook|guide|example)\b/iu;
const DOMAIN_ACTIVITIES: readonly { domain: Domain; patterns: readonly RegExp[] }[] = [
  { domain: "daily", patterns: [
    new RegExp("^" + ACTIVITY_PREFIX + "(?:安排|核对|记录|支付|整理|制定|更新)(?:家庭预算|家庭开支|个人预算|房租|水电费|家务|搬家|就医|体检|门诊)", "u"),
    new RegExp("^" + ACTIVITY_PREFIX + "(?:买菜|做饭|做家务|预约体检|预约门诊)(?:$|[^A-Za-z])", "u"),
    /^(?:I am )?(?:planning|reviewing|paying|updating) (?:my |our |the )?(?:household budget|personal budget|rent|utility bills|medical appointment)\b/i,
  ] },
  { domain: "work", patterns: [CLIENT_DESIGN,
    new RegExp("^" + ACTIVITY_PREFIX + "(?:为|给)(?:客户|公司|团队)(?:设计|创作|绘制|制作|交付|提交|准备|整理|完成|修改)", "u"),
    new RegExp("^" + ACTIVITY_PREFIX + "(?:整理|撰写|提交|更新|准备|完成|修改)(?:本周|这周|下周)?(?:工作周报|工作汇报|客户提案|项目交付|工作会议纪要|工作计划)", "u"),
    /^(?:client|customer) (?:logo|brand|poster|illustration) (?:design|proposal|concepts?)\b/i,
    /^(?:I am )?(?:designing|creating|preparing|delivering|revising) .+ for (?:a |the |my )?client\b/i,
  ] },
  { domain: "learning", patterns: [
    new RegExp("^(?=我|今天|明天|本周|下周|正在|在|继续|准备)" + ACTIVITY_PREFIX + "(?:学习(?!用品)|复习|备考|练习)\\s*\\S+", "u"),
    /^(?:复习|备考)(?!资料(?:$|[：:])|用品)\s*\S+/u,
    /^I am (?:studying|learning|revising|practicing)\s+\S/i,
  ] },
  { domain: "creation", patterns: [CLIENT_DESIGN,
    new RegExp("^" + ACTIVITY_PREFIX + "(?:(?:为|给)(?:客户|公司|团队))?(?:设计|创作|绘制)\\s*(?:一(?:个|份|幅|套))?\\s*(?:品牌标志|Logo|海报|插画|界面|页面)", "iu"),
    new RegExp("^" + ACTIVITY_PREFIX + "(?:撰写|写|续写|修改|创作)(?:小说|剧本|故事|游戏剧情|诗歌|歌词|散文)", "u"),
    /^(?:client|customer) (?:logo|brand|poster|illustration) (?:design|proposal|concepts?)\b/i,
    /^(?:I am )?(?:designing|creating|drawing|writing|revising) (?:a |the |my )?(?:logo|illustration|poster|novel|script|story)\b/i,
  ] },
  { domain: "interest", patterns: [
    new RegExp("^" + ACTIVITY_PREFIX + "(?:安排|记录|整理|计划)(?:周末徒步|业余摄影|兴趣活动|业余爱好|休闲活动|游戏游玩)", "u"),
    /^(?:I am )?(?:planning|recording|organizing) (?:a |my |our )?(?:weekend hike|hobby photography|leisure activity)\b/i,
  ] },
];
const UNCERTAIN_ZH = /(?:如果|假如|假设|除非|否则|不然|要是|若是|只要|一旦|示例|例子|举例|引用|转述|原文|文章说|建议|愿望|希望|也许|可能|是否|能否|不一定|只是讨论|尚未决定|还没决定|没有决定|不是(?:我的)?(?:承诺|决定|选择)|并非(?:我的)?(?:承诺|决定|选择))/u;
const UNCERTAIN_EN = /\b(?:if|unless|else|otherwise|when|once|provided|hypothetical|example|quotation|quoted|suggestion|wish|hope|maybe|might|whether|not necessarily|just discussing|not (?:my )?(?:commitment|decision))\b/i;
const REPORTED_ZH = /(?:他|她|客户|朋友|同事|对方|文章|原文|资料)(?:今天|昨天|刚才)?(?:说|表示|写道|告诉我|承诺|决定|要求|请求)/u;
const REPORTED_EN = /\b(?:he|she|they|the client|a friend|my colleague|the article)\s+(?:said|says|wrote|writes|promised|asked|states)\b/i;
const PAST_TASK_ZH = /(?:已经|昨天|昨日|上周|去年|曾经|当时|刚刚|之前|完成了|做完了|提交了|发送了|购买了|取消了|结束了|不保证|不承诺|不会|未完成|没有完成|已完成|(?:提交|发送|购买|完成|修复|支付|交付|报名|预约)(?:了|过|的))/u;
const PAST_TASK_EN = /\b(?:not|never|won't|cannot|can't|did|already|yesterday|previously|finished|completed|cancelled|canceled|no longer|used to|in the past)\b/i;
const ZH_TIME = "(?:今天|明天|后天|今晚|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天])(?:上午|下午|晚上|中午|之前|前)?";
const ZH_ACTION = /^(?:提交|报名|联系|预约|购买|完成|修复|发送|支付|交付|核对|整理|更新|安装|撰写|编写|阅读)\s*\S[\s\S]*$/u;
const ZH_TIMED_TASK = new RegExp("^我(?:会|计划)(?:在|于)?" + ZH_TIME + "[，,\\s]*(.+)$", "u");
const ZH_ACTION_TIME = new RegExp("^(?:在|于)?" + ZH_TIME + "[，,\\s]*", "u");
const EN_ACTION = /^(?:(?:today|tomorrow|tonight|next week|this week|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\s+)?(?:submit|send|book|register for|contact|buy|pay|finish|complete|fix|deliver|review|update|install|write|read)\s+\S[\s\S]*$/i;
const ZH_DECISION = /^我(?:已经|已|最终)?(?:决定|确定)(?:了)?(?:采用|选用|拒绝|放弃|保留|使用|购买|接受|不采用|不使用|不再使用|不选用|不购买|不接受|将|把|预算为)\s*\S[\s\S]*$/u;
const ZH_CHOICE = /^我(?:已经|已|最终)?选择(?:了)?\s*\S[\s\S]*$/u;
const EN_DECISION = /^I (?:(?:have decided to|have chosen to|choose to) (?:adopt|use|reject|keep|replace|stop using|buy|set)|have decided not to (?:adopt|use|buy)|(?:choose|have chosen))\s+\S[\s\S]*$/i;

function candidate(source: SuggestionSource, rule_id: string, reason: string): Candidate {
  return { status: "candidate", authoritative: false, source, rule_id, reason };
}

/** A linear quote/code mask prevents quoted first-person text from acting as an anchor. */
function excludedMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const closes: Record<string, string> = { "“": "”", "‘": "’", "「": "」", "『": "』", '"': '"', "'": "'" };
  let closing = "";
  for (let i = 0; i < text.length; i++) {
    if (closing) {
      mask[i] = 1;
      const apostrophe = closing === "'" && /[A-Za-z]/u.test(text[i - 1] ?? "") && /[A-Za-z]/u.test(text[i + 1] ?? "");
      if (text[i] === closing && text[i - 1] !== "\\" && !apostrophe) closing = "";
    } else if (text[i] === "`") {
      const delimiter = text.startsWith("```", i) ? "```" : "`";
      const end = text.indexOf(delimiter, i + delimiter.length);
      const last = end < 0 ? text.length : end + delimiter.length;
      mask.fill(1, i, last); i = last - 1;
    } else if (closes[text[i]] && !(text[i] === "'" && /[A-Za-z]/u.test(text[i - 1] ?? "") && /[A-Za-z]/u.test(text[i + 1] ?? ""))) {
      mask[i] = 1; closing = closes[text[i]];
    }
  }
  return mask;
}

function uncertain(text: string): boolean {
  return UNCERTAIN_ZH.test(text) || UNCERTAIN_EN.test(text) || /[?？]/u.test(text);
}

function purpose(text: string): string | null {
  for (const rule of PURPOSE_ANCHORS) {
    const match = rule.exec(text);
    if (match) return match[1];
  }
  return null;
}

const PURPOSE_ANCHORS = [
  /^(?:保存用途|收藏用途|记录用途|用途)\s*[:：]\s*(.+)$/u,
  /^我(?:保存|收藏|记下|留存)(?:这(?:份|篇|条|个|段)(?:资料|材料|文章|笔记|内容|教程|记录|链接|视频)?)?(?:是)?(?:为了|用于|用来)\s*(.+)$/u,
  /^(?:save purpose|purpose)\s*:\s*(.+)$/i,
  /^I (?:save|saved|keep|kept) (?:this|these)(?: (?:material|materials|article|notes|note|reference|video|link))? (?:for|to support)\s+(.+)$/i,
];

// The database generator consumes these same purpose rules. They contain no
// user content or execution rules; automatic organization never extracts Tasks.
export const IMPRINT_DOMAIN_RULESET = {
  version: "imprint-explicit-local.v2",
  purposes: PURPOSE_ANCHORS.map(rule => rule.source),
  domains: PURPOSE_DOMAINS.map(rule => ({ domain: rule.domain, patterns: [rule.zh.source, rule.en.source] })),
  activities: DOMAIN_ACTIVITIES.map(rule => ({ domain: rule.domain, patterns: rule.patterns.map(pattern => pattern.source) })),
  activity_context_block: ACTIVITY_CONTEXT_BLOCK.source,
  activity_material_block: ACTIVITY_MATERIAL_BLOCK.source,
  uncertain: [UNCERTAIN_ZH.source, UNCERTAIN_EN.source, "[?？]"],
  reported: [REPORTED_ZH.source, REPORTED_EN.source],
};

function taskStatement(text: string): boolean {
  if (PAST_TASK_ZH.test(text) || PAST_TASK_EN.test(text)) return false;
  const zh = /^我(?:将|承诺(?:会|将)?)\s*(.+)$/u.exec(text) ?? ZH_TIMED_TASK.exec(text);
  if (zh) return ZH_ACTION.test(zh[1].replace(ZH_ACTION_TIME, ""));
  const en = /^I (?:will|commit to|promise to|am going to)\s+(.+)$/i.exec(text);
  return !!en && EN_ACTION.test(en[1]);
}

function decisionStatement(text: string): boolean {
  // Wishes and commentary were rejected before this point. A direct choice is
  // still only a possible decision fragment, with no Currentness or authority.
  return ZH_DECISION.test(text) || ZH_CHOICE.test(text) || EN_DECISION.test(text);
}

function mixedTaskStatement(text: string): boolean {
  if (PAST_TASK_ZH.test(text) || PAST_TASK_EN.test(text)) return false;
  const anchor = new RegExp("^(?:待办\\s*[:：]\\s*|(?:我)?(?:需要|要|记得|计划|准备)(?:在|于)?(?:" + ZH_TIME + ")?[，,\\s]*|(?:在|于)?" + ZH_TIME + "[，,\\s]*)(.+)$", "u").exec(text);
  return !!anchor && (ZH_ACTION.test(anchor[1]) || /^交\s*\S[\s\S]*$/u.test(anchor[1]));
}

function mixedDecisionStatement(text: string): boolean {
  return decisionStatement(text) || decisionStatement("我" + text)
    || /^(?:decision|decided)\s*:\s*(?:use|adopt|reject|keep|replace|stop using)\s+\S[\s\S]*$/iu.test(text);
}

/**
 * Local, deterministic, read-only suggestions. Returns source-bound candidates;
 * never writes, makes model/network calls, creates tasks or supplies authority.
 * Absence of a match means abstention, not proof that no category/action exists.
 */
export function suggestImprintOrganization(content: string, options: SuggestionOptions = {}): ImprintSuggestions {
  const result: ImprintSuggestions = { status: "candidate", authoritative: false,
    execution_authorization: "NOT_GRANTED", rules_version: "imprint-explicit-local.v2", domains: [], fragments: [] };
  if (!content.trim() || options.sourceKind === "external_material") return result;
  const english = options.locale === "en";
  const mask = excludedMask(content);
  const domains = new Set<Domain>();
  let externalBlock = false;
  let offset = 0;
  for (const line of content.split("\n")) {
    const lineStart = offset; offset += line.length + 1;
    if (!line.trim()) { externalBlock = false; continue; }
    const reported = REPORTED_ZH.test(line) || REPORTED_EN.test(line);
    if (/^\s*(?:以下(?:是|为))?(?:客户(?:请求|要求|说|原话|邮件|消息)|对方(?:说|要求)|文章(?:说|内容)|原文|引用|转述|摘录|示例|例子|quoted text|client request|article says|example)\s*[:：]/iu.test(line)
      || (reported && /[:：]\s*$/u.test(line))) externalBlock = true;
    if (externalBlock || reported || /^\s*>/u.test(line) || uncertain(line)) continue;
    let segmentStart = 0;
    const process = (end: number) => {
      const raw = line.slice(segmentStart, end);
      const leading = /^\s*(?:[-*]\s+|\d+[.)]\s+)?/u.exec(raw)?.[0].length ?? 0;
      const body = raw.slice(leading).trimEnd();
      if (!body) return;
      const start = lineStart + segmentStart + leading;
      if (mask[start]) return;
      const source = { start, end: start + body.length, text: body };
      for (const rule of DOMAIN_ACTIVITIES) if (!domains.has(rule.domain) && !ACTIVITY_CONTEXT_BLOCK.test(line)
        && (rule.domain === "learning" || !ACTIVITY_MATERIAL_BLOCK.test(line))
        && rule.patterns.some(pattern => pattern.test(body))) {
        domains.add(rule.domain);
        result.domains.push({ ...candidate(source, "domain.explicit-activity." + rule.domain,
          english ? "The text names a concrete activity or use, rather than a topic, language or file format."
            : "正文写明了具体活动或用途，并非根据主题词、语言或文件格式归类。"), domain: rule.domain });
      }
      const savedPurpose = purpose(body);
      if (savedPurpose && !uncertain(savedPurpose) && !/(?:不用|不用于|不为了|not for|not to)/iu.test(savedPurpose)) {
        for (const piece of savedPurpose.split(/(?:[、，,；;]|以及|并用于|也用于|同时用于|\s+and\s+|\s+also\s+)/iu)) {
          const use = piece.trim().replace(/^(?:用于|为了|for)\s*/iu, "");
          for (const rule of PURPOSE_DOMAINS) if (!domains.has(rule.domain) && (rule.zh.test(use) || rule.en.test(use))) {
            domains.add(rule.domain);
            result.domains.push({ ...candidate(source, "domain.explicit-purpose." + rule.domain,
              english ? "The text explicitly states this saved purpose; language and tools were not used to infer it."
                : "正文明确写出保存用途；未根据材料语言、工具或格式推断。"), domain: rule.domain });
          }
        }
      }
      if (options.sourceKind !== "owner_text") return;
      if (taskStatement(body) || (options.mixedContent && mixedTaskStatement(body))) result.fragments.push({ ...candidate(source, "fragment.owner-future-action",
        english ? "A first-person commitment names a concrete future action. This is only a candidate for review."
          : "第一人称承诺写出了具体未来行动，仅作为待确认片段。"), kind: "task" });
      if (decisionStatement(body) || (options.mixedContent && mixedDecisionStatement(body))) result.fragments.push({ ...candidate(source, "fragment.owner-choice",
        english ? "A first-person statement explicitly adopts, rejects or chooses an option. This is only a candidate for review."
          : "第一人称语句明确采用、拒绝或选择了选项，仅作为待确认片段。"), kind: "decision" });
    };
    for (let i = 0; i < line.length; i++) {
      if (!mask[lineStart + i] && /[。！？.!?；;]/u.test(line[i])) { process(i); segmentStart = i + 1; }
      // Split a compound action/choice only when the next clause itself names I/我.
      else if (!mask[lineStart + i] && /[，,]/u.test(line[i]) && (/^\s*(?:我|I\s)/u.test(line.slice(i + 1))
        || (options.mixedContent && /^\s*(?:(?:已(?:经)?|最终)?(?:决定|确定|选择)|待办[:：]|(?:需要|记得)|(?:今天|明天|后天|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天]))/u.test(line.slice(i + 1))))) {
        process(i); segmentStart = i + 1;
      }
    }
    process(line.length);
  }
  return result;
}
