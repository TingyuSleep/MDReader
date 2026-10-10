/**
 * 状态栏用的文档度量。
 *
 * 为什么抽成纯函数、而不是在组件里就地算：
 *   字数统计的规则是**有分歧的** —— 中文按字还是按词？emoji 算几个？
 *   `well-known` 断不断成两个词？结尾换行要不要多算一行？
 *   写在 JSX 里就没法验收，只能靠肉眼看数字对不对。
 *   放这里之后 `dev/verify-status.mjs` 可以把每条规则逐个钉死。
 *
 * 采用的规则（与 Word、微信读书等中文写作工具一致）：
 *   - 中日韩字符**逐字**计数：`hello世界` = 2 个西文词 + 2 个汉字 = 4
 *   - 西文按词计，`-` 与 `'` 视为词内连接符：`well-known` 算一个词
 *   - 数字自成词：`v2` 算一个词
 *   - 字符数按 **Unicode 码点** 计，`😀` 与 `中` 都算 1
 *     （`String.length` 会把 😀 算成 2 —— 那是 UTF-16 码元数，不是用户眼里的字数）
 *   - 行数即 `\n` 分段数；空文档记 0 行。结尾换行会产生一个空行，和编辑器显示一致
 */

export interface DocMetrics {
  /** 词数：中日韩逐字 + 西文分词 */
  words: number;
  /** 字符数，按 Unicode 码点计，**含**空白与换行 */
  chars: number;
  /** 不含任何空白字符的字符数 */
  charsNoSpace: number;
  /** 行数；空文档为 0 */
  lines: number;
}

/**
 * 中日韩文字：假名、注音、汉字（含扩展 A 与兼容区）、谚文，外加扩展 B 以上的补充平面。
 *
 * 不写成 `\u4E00-\u9FFF` 一条：那样会漏掉生僻字（`𠮷` 这类扩展 B 字）与日韩假名，
 * 导致一份日文文档的"字数"直接归零。
 */
const CJK_CHAR =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]|[\u{20000}-\u{2FA1F}]/gu;

/**
 * 西文词：字母数字起头，允许词内夹 `'` `’` `-`。
 *
 * ⚠ 必须带 `g`，且只能用 `String.prototype.match` 取全部匹配 ——
 * `match` 在带 `g` 时会自己重置 `lastIndex`，所以模块级复用同一个正则是安全的。
 * 换成 `regex.exec()` 循环就必须手动重置，是这类常量正则最常见的翻车点。
 */
const WESTERN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

const WHITESPACE = /\s/u;

/** 词数：中日韩逐字 + 西文分词。空串得 0，不做任何兜底假数据。 */
export function countWords(text: string): number {
  if (text.length === 0) return 0;
  const cjk = text.match(CJK_CHAR);
  const western = text.match(WESTERN_WORD);
  return (cjk?.length ?? 0) + (western?.length ?? 0);
}

/**
 * 字符数。
 *
 * 用 `for...of` 遍历字符串 —— 它按**码点**迭代，所以 😀 只走一轮。
 * 同一趟里顺手统计"不含空白"，避免为了第二个数字再扫一遍全文。
 *
 * 刻意不写 `[...text].length`：那会为一篇 5 MB 的文档凭空造一个几十万元素的数组，
 * 而状态栏是每敲一个字都要重算的。
 */
function countChars(text: string): { chars: number; charsNoSpace: number } {
  let chars = 0;
  let charsNoSpace = 0;
  for (const ch of text) {
    chars += 1;
    if (!WHITESPACE.test(ch)) charsNoSpace += 1;
  }
  return { chars, charsNoSpace };
}

/** 一次算齐状态栏要的全部数字 */
export function measureDocument(text: string): DocMetrics {
  const { chars, charsNoSpace } = countChars(text);
  return {
    words: countWords(text),
    chars,
    charsNoSpace,
    // 空文档是 0 行而不是 1 行 —— 否则欢迎页会显示"行 1"，看着像已经开了个文档
    lines: text.length === 0 ? 0 : text.split("\n").length,
  };
}

/** 光标位置文案。列从 1 开始，与编辑器行号栏一致，不用 0 基。 */
export function formatCursor(line: number, col: number): string {
  return `行 ${line} 列 ${col}`;
}
