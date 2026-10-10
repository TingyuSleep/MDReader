/**
 * 导出为独立 HTML。
 *
 * 目标产物是**一个自包含的 .html 文件**：双击能在任何浏览器里打开、看起来和
 * 应用里的实时预览一致、不依赖任何外部资源（项目本来就不允许 CDN）。
 *
 * 三个关键决定：
 *
 * 1. **正文复用同一条渲染管线**（markdown-it + highlight.js → DOMPurify），
 *    而不是另起一套。解析器那 217 KB 用动态 import 拉到独立 chunk，
 *    只有用户真的点「导出」时才加载，不拖慢启动。
 *
 * 2. **样式从当前文档的样式表里按选择器挑出来内联**，而不是在 TS 里再手写一份。
 *    手写一份必然和应用里的样式慢慢漂移（这个项目最不缺的就是「改了一处忘了另一处」）。
 *    只挑三类：`:root` / `.dark` 的自定义属性（颜色令牌）、`.markdown-body*`、含 `.hljs` 的。
 *    代码高亮配色本来就全部挂在 `.markdown-body` 下，所以一条规则就能覆盖。
 *
 * 3. **构建过程是纯函数**（buildStandaloneHtml），DOM 依赖只在 pickExportCss 里。
 *    这样导出结果可以被逐条断言，而不是「看起来差不多」。
 */
import { pickExportHtmlPath, writeFile } from "./fs";

// ------------------------------------------------------------ 纯函数：拼文档

export interface StandaloneHtmlOptions {
  /** 文档标题，会写进 <title> 与 h1 上方（转义后） */
  title: string;
  /** **已经过 DOMPurify 清洗**的正文 HTML */
  bodyHtml: string;
  /** 要内联的样式表内容，由 pickExportCss() 产出 */
  css: string;
  /** 导出时的主题，决定 <html> 上有没有 dark 类 */
  dark: boolean;
  /** 生成时间，写进 <meta name="generator"> 之类的位置；不传则省略 */
  generatedAt?: string;
}

/** 页面自身需要的极简样式。应用的样式表里没有 reset，得自己补。 */
const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light}
html.dark{color-scheme:dark}
body{margin:0;padding:3rem 1.25rem 6rem;background:var(--preview-bg,#fff);color:var(--foreground,#161616);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.export-page{max-width:52rem;margin:0 auto}
.export-meta{margin:0 0 2rem;padding-bottom:1rem;border-bottom:1px solid var(--border,#e5e5e5);
font-size:.75rem;color:var(--muted-foreground,#777)}
@media print{body{padding:0;background:#fff;color:#000}.export-page{max-width:none}.export-meta{display:none}}`;

export function escapeHtmlText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 组装最终文档。
 *
 * `lang="zh-CN"` 是写死的：本项目面向中文用户，导出物主要是给人读的，
 * 语言标记错了会影响字体回退与朗读。真要支持多语言，应该从文档内容里推断。
 */
export function buildStandaloneHtml(options: StandaloneHtmlOptions): string {
  const { title, bodyHtml, css, dark, generatedAt } = options;
  const safeTitle = escapeHtmlText(title);
  const meta = generatedAt
    ? `<p class="export-meta">导出时间 ${escapeHtmlText(generatedAt)}</p>`
    : "";

  return `<!doctype html>
<html lang="zh-CN"${dark ? ' class="dark"' : ""}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="MD阅读器">
<title>${safeTitle}</title>
<style>
${BASE_CSS}
</style>
<style>
${css}
</style>
</head>
<body>
<main class="export-page">
${meta}
<article class="markdown-body">
${bodyHtml}
</article>
</main>
</body>
</html>
`;
}

// ------------------------------------------------------------ 样式提取（需要 DOM）

/**
 * 要保留的规则。
 *
 * 选择器匹配**不做行首锚定**：`.markdown-body` 可能出现在选择器中间
 * （例如 `.dark .markdown-body pre`），锚定会漏掉暗色主题下的那批规则。
 *
 * 颜色令牌单独用一份白名单，而且**只认 `:root` / `.dark` / `:host`**。
 * 这里踩过一次：一开始把 `html` 也放进白名单，结果
 * `html, body, #root { height: 100% }` 这种复合选择器因为含 `html` 被整条收走，
 * 把应用外壳的 `#root` 规则一起带进了导出文件。
 * 按逗号拆开逐段判断能解决「复合选择器整条命中」的问题，但前提是白名单本身要窄。
 */
const KEEP_SELECTOR = /\.markdown-body\b|\.hljs\b/;
const TOKEN_SELECTORS = new Set([":root", ".dark", ":host"]);

function isKeepable(selectorText: string): boolean {
  return selectorText
    .split(",")
    .map((part) => part.trim())
    .some((part) => KEEP_SELECTOR.test(part) || TOKEN_SELECTORS.has(part));
}

/**
 * 递归收集。
 *
 * 先判 `selectorText`：普通样式规则才做选择器匹配；
 * 没有 selectorText 的按「分组规则」处理（`@media` / `@supports` / `@layer`），
 * 只在内部确实有命中时才把外层原样包回去 —— 否则会导出一堆空壳。
 */
function collectRules(rules: CSSRuleList, out: string[]): void {
  for (const rule of Array.from(rules)) {
    const selectorText = (rule as CSSStyleRule).selectorText;
    if (typeof selectorText === "string") {
      if (isKeepable(selectorText)) out.push(rule.cssText);
      continue;
    }

    const nested = (rule as CSSGroupingRule).cssRules;
    if (!nested || nested.length === 0) continue;

    const inner: string[] = [];
    collectRules(nested, inner);
    if (inner.length === 0) continue;

    const brace = rule.cssText.indexOf("{");
    const prelude = brace > 0 ? rule.cssText.slice(0, brace).trim() : "";
    if (prelude) out.push(`${prelude}{\n${inner.join("\n")}\n}`);
  }
}

/**
 * 从当前文档的样式表里挑出导出需要的规则。
 *
 * 读不到的样式表（跨域）会被跳过 —— 本项目全是同源，正常不会触发。
 * 挑选结果为空时返回空串，由调用方决定要不要告警；
 * 这里不抛错，因为「样式没内联出来」不该阻断导出本身。
 */
export function pickExportCss(doc: Document = document): string {
  const out: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      collectRules(sheet.cssRules, out);
    } catch {
      // 跨域样式表：读 cssRules 会抛 SecurityError，跳过
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------ 正文准备

/**
 * 把渲染器留下的 `data-md-src` 补成 `src`。
 *
 * 渲染期刻意不写 src（避免 WebView 去请求必然 404 的地址），真正的地址由
 * `resolveAssetImages` 在 DOM 里补。导出物是**静态文件**，没有 asset 协议可用，
 * 所以这里退回相对路径本身 —— 把 .html 和图片放在一起就能正常显示。
 *
 * 纯字符串替换，不碰 DOM，因此可以被逐条断言。
 */
export function materializeRelativeImages(html: string): { html: string; count: number } {
  let count = 0;
  const next = html.replace(/data-md-src="([^"]*)"/g, (whole, raw: string) => {
    // 明确拒绝能执行脚本的协议。img 的 src 本来不执行 javascript:，
    // 但导出物会被别人拿去当模板用，不给自己留这个口子。
    if (/^\s*(?:javascript|vbscript|file):/i.test(raw)) return whole;
    count += 1;
    return `src="${raw}"`;
  });
  return { html: next, count };
}

/**
 * 渲染一段 Markdown 成**已清洗**的 HTML。
 *
 * 解析器走动态 import：markdown-it + highlight.js 合计约 217 KB，
 * 放进首屏主包会白白拖慢启动（markdown-parse.ts 的文件头注释专门写了这件事）。
 */
export async function renderSanitizedHtml(markdown: string): Promise<string> {
  const [{ parseMarkdown }, { sanitizeHtml }] = await Promise.all([
    import("./markdown-parse"),
    import("./markdown-sanitize"),
  ]);
  return sanitizeHtml(parseMarkdown(markdown).html);
}

// ------------------------------------------------------------ 文件名

/** `D:\笔记\周报.md` → `周报.html`；没有源文件时用「未命名文档」 */
export function defaultExportName(sourcePath: string | null): string {
  if (!sourcePath) return "未命名文档.html";
  const normalized = sourcePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = base.replace(/\.[^.]+$/, "") || "未命名文档";
  return `${stem}.html`;
}

// ------------------------------------------------------------ 编排（会碰磁盘）

export type ExportOutcome =
  | { status: "cancelled" }
  | { status: "written"; path: string; bytes: number };

/**
 * 一条龙：渲染 → 拼文档 → 弹保存框 → 落盘。
 *
 * 顺序上先渲染再弹框，看起来多花了时间，但反过来更糟：用户选完路径才发现
 * 渲染失败，白选一次。渲染是毫秒级的，用户感知不到。
 */
export async function exportHtmlFile(params: {
  markdown: string;
  title: string;
  sourcePath: string | null;
  dark: boolean;
}): Promise<ExportOutcome> {
  const bodyHtml = await renderSanitizedHtml(params.markdown);
  const materialized = materializeRelativeImages(bodyHtml);

  const html = buildStandaloneHtml({
    title: params.title,
    bodyHtml: materialized.html,
    css: pickExportCss(),
    dark: params.dark,
    generatedAt: new Date().toLocaleString("zh-CN"),
  });

  const target = await pickExportHtmlPath(defaultExportName(params.sourcePath));
  if (!target) return { status: "cancelled" };

  await writeFile(target, html);
  // 用 UTF-8 字节数而不是字符串长度：中文一个字 3 字节，
  // 报字符数会让用户以为文件比实际小得多。
  return { status: "written", path: target, bytes: new TextEncoder().encode(html).length };
}
