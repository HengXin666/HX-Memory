// kernel/secret-shape.ts — **凭据形态**判定: 这条内容该不该进记忆库。
//
// ## 为什么必须有它 (2026-10-05 实测发现)
//
// 真库里**已经躺着明文凭据**, 逐条实测:
//   · `pw=qq282000500` (context, 用户在某轮把口令打进了对话)
//   · `"使用 W@daodun666 作为解压密码"` (context)
//   · `HX-ProxyGroup … loli 的密码为 qq282000500 …` (context)
//
// 记忆库的用途是"下次能查到", 而这恰恰是凭据最不该有的性质  它会被**注入进上下文**、
// 被 memory_search 返回、被面板展示、被 git 提交 (真相文件是 Markdown)。而密码一旦进了
// 长期记忆, 就没有"撤回"这回事了 (shadow 只影响检索, 正文仍在文件里)。
//
// ## 判据: 只认**确定的形态**, 不猜
//
// 三类 (全部是"看起来就是凭据"的形状, 而非"提到了密码这个词"):
//   1. **赋值式**: `pw=xxx` / `password: xxx` / `token=xxx` / `api_key=xxx`
//       键名是凭据词、右侧是一个像值的串;
//   2. **口令句**: "密码是 xxx" / "口令为 xxx" / "作为解压密码"  中文语序的赋值;
//   3. **高熵字面量**: 形如 `sk-…` / `ghp_…` / `AKIA…` 这类**有前缀的 token**。
//
// 边界 (宁可不拦, 不要错杀): 提到"密码"本身**不算**  例如
//   · "必须用 credentials.py 读 .secrets/credentials.json" (在说做法, 不含值)
//   · "密码要用 scrypt 存哈希" (在说规范)
// 这两类要被放行, 否则记忆库会丢掉大量**关于凭据的正确做法** (那反而是最该记的)。
//
// ## 与捕获链的关系
//
// 判定发生在**写入前**: 命中即**不落盘**, 并把理由回报给账本 (用户能看到"这一轮因为
// 含凭据被拒"), 而不是静默丢弃  静默丢弃正是本仓反复修的那类缺陷。
import { normalizeVoice } from "./voice.ts";

/** 凭据词 (键名侧; 只用于"赋值式"判据的左半边)。 */
const SECRET_KEYS = [
  "pw", "pwd", "passwd", "password", "pass", "密码", "口令", "秘钥", "密钥",
  "token", "api_key", "apikey", "api-key", "secret", "credential", "access_key",
  "private_key", "auth_token", "session_token", "pat",
];

/** 有前缀的 token 形态 (高置信: 这些前缀本身就是"这是密钥"的标记)。 */
const TOKEN_PREFIXES = [
  /sk-[A-Za-z0-9_-]{16,}/,          // OpenAI / Anthropic 风格
  /ghp_[A-Za-z0-9]{20,}/,           // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[A-Z0-9]{16}/,               // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/,   // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM 私钥
];

/** 判定的输入面。 */
export interface SecretVerdict {
  /** 是否判为凭据 (命中即不应落盘)。 */
  isSecret: boolean;
  /** 命中的判据 (可审计; 面板/账本据此解释"为什么这条没进库")。 */
  reason: string;
}

export const NOT_SECRET: SecretVerdict = { isSecret: false, reason: "" };

/** 右侧"像值"的形状: 不能是纯中文短语 (那多半是在描述, 不是在给值)。 */
function looksLikeValue(s: string): boolean {
  const v = s.trim();
  if (v.length < 4 || v.length > 200) return false;
  // 含数字/符号, 或是一串较长无空格的拉丁/混排  "qq282000500" / "W@daodun666" 都符合。
  if (/[0-9]/.test(v) && /^[^\s，。；;,]{4,}$/.test(v)) return true;
  if (/^[A-Za-z0-9+/=_@.!$%^&*#-]{8,}$/.test(v)) return true;
  return false;
}

/**
 * 判定一段文本是否**本身就是凭据**(而不是"关于凭据的做法")。
 *
 * 三条判据见文件头注; 任一命中即算。
 */
export function detectSecret(rawText: string): SecretVerdict {
  const text = normalizeVoice(String(rawText ?? ""));
  if (!text.trim()) return NOT_SECRET;

  // ---- 1) 有前缀的 token (最高置信, 先判) ----
  for (const p of TOKEN_PREFIXES) {
    if (p.test(text)) return { isSecret: true, reason: "凭据形态: 带前缀的密钥字面量" };
  }

  // ---- 2) 赋值式: `pw=xxx` / `password: xxx` / `token = xxx` ----
  // ⚠ 用**键名 + 值**两侧都判: 只看键名会把 "password 字段要用 scrypt" 这种正确做法也拦掉
  // (那句话里 "password" 后面跟的是"字段要用…", 不像值)。实测误杀样本就是它。
  for (const key of SECRET_KEYS) {
    const re = new RegExp(
      "(?:^|[\\s，。；;、])" + key.replace(/[-_]/g, "[-_]?") + "\\s*[:=＝为是]\\s*([^\\n]{2,})",
      "i",
    );
    const m = re.exec(text);
    if (m?.[1] && looksLikeValue(m[1])) {
      return { isSecret: true, reason: "凭据形态: 赋值式 (" + key + "=<值>)" };
    }
  }

  // ---- 3) 口令句: "作为解压密码" / "密码是 xxx" ----
  // 只在这种"正在交付一个值"的语序上命中:
  const phrase = /(?:作为|用作|就是|是|为)\s*[^，。；;\s]{0,6}(?:密码|口令)[:：]?\s*([^\s，。；;]{4,})/.exec(text);
  if (phrase?.[1] && looksLikeValue(phrase[1])) {
    return { isSecret: true, reason: "凭据形态: 口令句" };
  }
  const passIs = /(?:密码|口令|口訣|解压密码)\s*(?:是|为|＝|=|:)\s*([^\s，。；;]{4,})/.exec(text);
  if (passIs?.[1] && looksLikeValue(passIs[1])) {
    return { isSecret: true, reason: "凭据形态: 口令句 (密码是…)" };
  }
  // ⚠ **值在前**的语序 (2026-10-05 实测漏网): "使用 W@daodun666 作为解压密码" 
  // 值是 `W@daodun666`, 而它出现在"密码"二字的**左边**。只判右边会漏掉这一整类中文语序
  // (而它正是真库里那条实测样本的形态)。判据: `用 X 作为/当作 Y密码`。
  const valueBefore = /(?:用|使用|拿|以)\s*([^\s，。；;]{4,})\s*(?:作为|当作|用作)\s*[^\s，。；;]{0,6}(?:密码|口令)/.exec(text);
  if (valueBefore?.[1] && looksLikeValue(valueBefore[1])) {
    return { isSecret: true, reason: "凭据形态: 口令句 (用 X 作为密码)" };
  }

  return NOT_SECRET;
}
