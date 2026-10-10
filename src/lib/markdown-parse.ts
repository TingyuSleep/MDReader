/**
 * 渲染管线 · 第一段：解析 + 高亮。
 *
 * ⚠ 这个模块**只应该被 Web Worker 引用**（src/lib/worker/render.worker.ts）。
 *
 * 它顶层 import 了 markdown-it + markdown-it-task-lists + highlight.js（含 18 种语言），
 * 合计约 217 KB。主线程唯一需要的清洗逻辑在 markdown-sanitize.ts 里 ——
 * 如果哪天有人在主线程 import 了本文件，就会白白多加载并求值这 217 KB，
 * 启动时间直接受影响。拆成两个文件就是为了防这件事。
 *
 * 本模块不碰 DOM、不碰 Tauri API，纯函数，Worker 安全。
 * 产出的是**未清洗的 HTML**，进 DOM 前必须过 markdown-sanitize 的 sanitizeHtml()。
 */
import MarkdownIt from "markdown-it";
import type { Env, MarkdownIt as MarkdownItInstance } from "markdown-it";
import taskLists from "markdown-it-task-lists";

import { highlightCode, normalizeLanguageInfo } from "./highlight";
import { isDirectlyLoadable } from "./markdown-path";
import type { TocItem } from "@/types";

// ------------------------------------------------------------ 对外类型

export interface ParseResult {
  /** markdown-it 产出的**未清洗** HTML，进 DOM 前必须过 sanitizeHtml() */
  html: string;
  toc: TocItem[];
}

/** 渲染期挂在 markdown-it env 上的私有状态。用 type 而非 interface，
 *  这样能拿到隐式索引签名，可以安全赋给 markdown-it 的 Env。 */
type RenderEnv = {
  toc: TocItem[];
  /** 已占用的锚点 id → 出现次数，用于去重 */
  slugUsage: Map<string, number>;
};

// ------------------------------------------------------------ 小工具

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(input: string): string {
  return escapeHtml(input).replace(/'/g, "&#39;");
}

/** 标题文本 → 锚点 slug。保留中日韩与字母数字，其余折叠成连字符。 */
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** 去重：第二次出现的 "安装" 变成 "安装-2" */
function uniqueSlug(env: RenderEnv, base: string): string {
  const usage = (env.slugUsage ??= new Map<string, number>());
  const seen = usage.get(base) ?? 0;
  usage.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

// ------------------------------------------------------------ markdown-it 实例

/** 代码块统一输出的结构，方便 CSS 与后续「复制代码」按钮挂载 */
function renderCodeBlock(content: string, info?: string | null): string {
  const label = normalizeLanguageInfo(info);
  const highlighted = highlightCode(content, info);

  const preAttrs = [`class="md-code-block"`];
  if (label) preAttrs.push(`data-lang="${escapeAttr(label)}"`);

  const codeAttrs: string[] = [];
  if (highlighted) {
    codeAttrs.push(`class="hljs${label ? ` language-${escapeAttr(label)}` : ""}"`);
  } else if (label) {
    codeAttrs.push(`class="language-${escapeAttr(label)}"`);
  }

  // highlightCode 返回的已经是转义过的 HTML；降级路径要自己转义。
  // fence 的 content 末尾带一个换行，去掉后由 CSS 控制行距，避免块底多出一行。
  const body = highlighted ?? escapeHtml(content.replace(/\n$/, ""));

  return `<pre ${preAttrs.join(" ")}><code${codeAttrs.length ? ` ${codeAttrs.join(" ")}` : ""}>${body}</code></pre>\n`;
}

/**
 * 创建 markdown-it 实例。
 *
 * ⚠ markdown-it-task-lists 的选项存在**模块级变量**里，所以本函数每次调用
 *   必须传同一组选项，否则会互相覆盖。这里固定 { enabled: false }（预览只读）。
 */
export function createMarkdownIt(): MarkdownItInstance {
  const md = new MarkdownIt({
    // 第一道 XSS 防线：Markdown 源文里的原始 HTML 一律不解析
    html: false,
    // 标准 Markdown 语义：单个换行不等于 <br>（GFM 里要靠行尾两个空格）
    breaks: false,
    // GFM 自动链接
    linkify: true,
    // 中文语境下 typographer 的 smartquotes 会把引号改成弯引号，反而变丑，关掉
    typographer: false,
    xhtmlOut: false,
    langPrefix: "language-",
  });

  md.use(taskLists, { enabled: false, label: false, labelAfter: false });

  // ---------------- 标题：写 id + 收集目录 ----------------
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (!token) return "";

    const inline = tokens[idx + 1];
    const level = Number(token.tag.slice(1)) || 1;
    const text = inline
      ? self.renderInlineAsText(inline.children ?? [], options, env).trim()
      : "";

    const renderEnv = env as unknown as RenderEnv | undefined;
    if (renderEnv) {
      const id = uniqueSlug(renderEnv, slugify(text || `h${level}`));
      token.attrSet("id", id);
      renderEnv.toc.push({ level, text: text || `h${level}`, id });
    }

    return self.renderToken(tokens, idx, options);
  };

  // ---------------- 链接：统一加标记，点击交给上层拦截 ----------------
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    if (token) {
      // 所有链接都打标记：Tauri 里绝不允许 WebView 自行导航，
      // 点击一律由上层拦截后决定（外链转系统浏览器 / 锚点滚动 / 其余忽略）。
      // 这里**刻意不写 target**：_blank 在某些配置下会让 WebView 开新窗口，
      // 那正好违反「不在 WebView 内导航」的要求。
      token.attrSet("data-md-link", "1");
      token.attrSet("rel", "noopener noreferrer nofollow");
    }
    return self.renderToken(tokens, idx, options);
  };

  // ---------------- 图片：区分「可直接加载」与「需按文档目录解析」 ----------------
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return "";

    const rawSrc = String(token.attrGet("src") ?? "").trim();
    const alt = escapeAttr(token.content ?? "");
    const title = token.attrGet("title");

    const attrs: string[] = [`alt="${alt}"`, `loading="lazy"`, `decoding="async"`];
    if (title != null) attrs.push(`title="${escapeAttr(String(title))}"`);

    if (isDirectlyLoadable(rawSrc)) {
      // 已经是 http(s)/data/blob/asset:// ，直接加载
      attrs.unshift(`src="${escapeAttr(rawSrc)}"`);
    } else {
      // 相对路径 / Windows 盘符路径：**先不写 src**，避免 WebView 去请求一个必然 404 的地址。
      // 真正的地址由 resolveAssetImages() 在清洗后填上。
      attrs.push(`data-md-src="${escapeAttr(rawSrc)}"`);
    }

    return `<img ${attrs.join(" ")}>`;
  };

  // ---------------- 代码：围栏块与缩进块统一结构 ----------------
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return "";
    return renderCodeBlock(token.content, token.info);
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return "";
    return renderCodeBlock(token.content, null);
  };

  return md;
}

/** 单例。主线程与 Worker 各自持有一份，互不干扰。 */
let instance: MarkdownItInstance | null = null;

export function getMarkdownIt(): MarkdownItInstance {
  instance ??= createMarkdownIt();
  return instance;
}

// ------------------------------------------------------------ 对外入口

/** 解析 + 高亮。纯函数，Worker 安全。返回的 html **未清洗**。 */
export function parseMarkdown(source: string): ParseResult {
  const env: RenderEnv = { toc: [], slugUsage: new Map<string, number>() };
  const html = getMarkdownIt().render(source, env as unknown as Env);
  return { html, toc: env.toc };
}
