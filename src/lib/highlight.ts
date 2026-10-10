/**
 * 代码高亮：highlight.js 按需注册。
 *
 * 为什么不用 `highlight.js/lib/common`：那个包带 30+ 种语言。
 * 更不能用默认入口 `highlight.js`：那是 190+ 种语言的全量包。
 * 这里只注册实际用得上的 18 种，体积可控，且完全离线。
 *
 * ⚠ 本模块输出的 HTML 片段（含 <span class="hljs-*">）属于**未经清洗的 HTML**，
 *   必须经 DOMPurify 清洗后才能进入 DOM。见 markdown-sanitize.ts 的 sanitizeHtml()。
 */
import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** 注册表：键是 highlight.js 的正式语言名 */
const LANGUAGE_DEFINITIONS: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGE_DEFINITIONS)) {
  hljs.registerLanguage(name, definition);
}

/** 自动探测时只在这些语言里挑，避免把范围摊到 190 种上 */
const AUTO_DETECT_SUBSET: string[] = Object.keys(LANGUAGE_DEFINITIONS);

/**
 * 自动探测的最低可信度阈值。
 *
 * highlight.js 的 relevance 是它内部累加的打分：普通散文通常 1~4，
 * 真正的代码片段一般 8 以上。阈值定太低会让散文被误判成代码而满屏变色，
 * 定太高又会让冷门语言失去高亮。8 是实测下来比较稳的折中值。
 */
const AUTO_DETECT_MIN_RELEVANCE = 8;

/**
 * fence 的 info string → highlight.js 语言名的别名表。
 *
 * highlight.js 自己带了一部分别名（bash 有 sh/zsh，xml 有 html 等），
 * 这里补的是它没覆盖、但写 Markdown 时很常见的写法。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  // JavaScript 家族
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  node: "javascript",
  // TypeScript 家族（tsx 只有 typescript 可用，不做 JSX 细分）
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  // Shell
  shell: "bash",
  "shell-session": "bash",
  console: "bash",
  sh: "bash",
  zsh: "bash",
  // 标记语言
  htm: "xml",
  html: "xml",
  svg: "xml",
  vue: "xml",
  xhtml: "xml",
  // 其他
  rs: "rust",
  py: "python",
  python3: "python",
  "c++": "cpp",
  cc: "cpp",
  h: "cpp",
  hpp: "cpp",
  md: "markdown",
  mkd: "markdown",
  yml: "yaml",
  docker: "dockerfile",
  containerfile: "dockerfile",
  jsonc: "json",
  json5: "json",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  // 常见 SQL 方言
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql",
  sqlite: "sql",
};

/** 明确表示「不要高亮」的 info string */
const PLAIN_LANGUAGE_INFO = new Set(["text", "txt", "plain", "plaintext", "none", "raw", "output"]);

export interface LanguageResolution {
  /** 命中的、已注册的语言名；空串表示没有可用语言 */
  language: string;
  /**
   * 未命中时是否允许走自动探测。
   *
   * - info 为空 → false（不猜，避免无脑猜测把正文染成五颜六色）
   * - info 是 text / plaintext 这类显式声明 → false
   * - info 写了但没注册（例如 ```foo）→ true
   */
  allowAutoDetect: boolean;
}

/**
 * 解析 fence 的 info string。
 *
 * markdown-it 会把 ```js title="a" 整串塞进 token.info，
 * 所以只取第一段作为语言标记。
 */
export function resolveLanguage(info?: string | null): LanguageResolution {
  const first = (info ?? "").trim().split(/[\s,{]/)[0]?.toLowerCase() ?? "";
  if (!first || PLAIN_LANGUAGE_INFO.has(first)) {
    return { language: "", allowAutoDetect: false };
  }

  const alias = LANGUAGE_ALIASES[first];
  if (alias && hljs.getLanguage(alias)) {
    return { language: alias, allowAutoDetect: false };
  }

  // highlight.js 自带别名会在这里命中（例如 sh → bash）
  if (hljs.getLanguage(first)) {
    return { language: first, allowAutoDetect: false };
  }

  return { language: "", allowAutoDetect: true };
}

/** 语言标签：用于代码块右上角显示。取 info 的第一段原样小写。 */
export function normalizeLanguageInfo(info?: string | null): string {
  return (info ?? "").trim().split(/[\s,{]/)[0]?.toLowerCase() ?? "";
}

/**
 * 高亮代码。
 *
 * 返回 **未清洗的 HTML 片段**；无法/无需高亮时返回 null，
 * 调用方应当降级为纯文本 <pre><code>（内容需自行转义）。
 *
 * 任何异常都会被吞掉并降级为 null —— 高亮失败绝不能影响正文渲染。
 */
export function highlightCode(code: string, info?: string | null): string | null {
  if (!code) return null;

  const { language, allowAutoDetect } = resolveLanguage(info);

  try {
    if (language) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    if (allowAutoDetect) {
      const auto = hljs.highlightAuto(code, AUTO_DETECT_SUBSET);
      return auto.relevance >= AUTO_DETECT_MIN_RELEVANCE ? auto.value : null;
    }
    return null;
  } catch (err) {
    console.warn("[highlight] 高亮失败，已降级为纯文本", err);
    return null;
  }
}

/** 已注册的语言名列表（供调试与自动探测范围展示） */
export function registeredLanguages(): string[] {
  return [...AUTO_DETECT_SUBSET];
}
