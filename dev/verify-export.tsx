/**
 * 批次 10 的验收脚本：导出为独立 HTML。用完即删。
 *
 * 分三层验，因为这三层「出错的样子」完全不同：
 *
 *   1. **拼文档**（纯函数）。导出物是一份要交出去的文件，缺一个 `<meta charset>`
 *      就是乱码，漏转义一个 `<` 就是坏文档。这些从文件内容上逐条钉死，
 *      比"打开看看挺正常的"可靠得多。
 *
 *   2. **样式提取**。这一层的成败**只有跑在真实样式表上才能验** ——
 *      `pickExportCss()` 读的是 document.styleSheets，纯函数测试给不出这个环境。
 *      重点验两件事：该带的带出来了（颜色令牌 / .markdown-body / .hljs），
 *      不该带的没带（应用外壳的 .cm-editor / #root 之类）。
 *      漏带 → 导出的文件白底黑字毫无排版；多带 → 把编辑器样式一起塞进去，
 *      在别的页面里可能反过来污染。
 *
 *   3. **端到端**。真的把一段 Markdown 走完整条管线（markdown-it → DOMPurify →
 *      拼文档），验最终产物自包含、且安全边界还在。
 */
// 验收构建没有 index.html 入口，必须显式引主题与表格样式，否则 pickExportCss 提取不到东西
import "@/index.css";

import {
  buildStandaloneHtml,
  defaultExportName,
  escapeHtmlText,
  materializeRelativeImages,
  pickExportCss,
  renderSanitizedHtml,
} from "@/lib/export-html";

// ------------------------------------------------------------ 骨架

interface Result {
  name: string;
  pass: boolean;
  info: string;
}

const results: Result[] = [];
const record = (name: string, pass: boolean, info = ""): void => {
  results.push({ name, pass, info });
};

const steps: string[] = [];
(window as unknown as Record<string, unknown>).__verifySteps = steps;
const t0 = performance.now();
const step = (name: string): void => {
  steps.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${name}`);
};

/** 断言辅助：把「包含 / 不包含」写短一点，失败信息里带上真实片段 */
const has = (haystack: string, needle: string): boolean => haystack.includes(needle);

const snippet = (text: string, needle: string): string => {
  const idx = text.indexOf(needle);
  if (idx < 0) return `未找到 ${JSON.stringify(needle)}`;
  return JSON.stringify(text.slice(Math.max(0, idx - 20), idx + needle.length + 20));
};

// ------------------------------------------------------------ 1. 拼文档（纯函数）

function testBuildStandaloneHtml(): void {
  const base = {
    title: "示例文档",
    bodyHtml: "<h1 id=\"a\">标题</h1>\n<p>正文</p>",
    css: ".markdown-body{color:red}",
    dark: false,
  };

  const light = buildStandaloneHtml(base);
  const deep = buildStandaloneHtml({ ...base, dark: true });

  record("以 <!doctype html> 开头", light.startsWith("<!doctype html>"), light.slice(0, 20));
  record("浅色：<html lang=\"zh-CN\"> 且不带 dark 类", has(light, '<html lang="zh-CN">'), light.slice(0, 60));
  record(
    "深色：<html> 上带 dark 类（暗色令牌才会生效）",
    has(deep, '<html lang="zh-CN" class="dark">'),
    deep.slice(0, 60),
  );
  record(
    "声明了 UTF-8 —— 少了它中文在别的机器上就是乱码",
    has(light, '<meta charset="UTF-8">'),
    snippet(light, "charset"),
  );
  record("带 viewport，手机上打开不会缩成一团", has(light, 'name="viewport"'), "");

  // 标题是最容易被漏掉的一处：它进的是 <title> 标签，用户起的文件名可以含任意字符
  const tricky = buildStandaloneHtml({ ...base, title: '<x>&"\'' });
  record(
    "标题里的尖括号/引号被转义（不能把 </title> 提前闭合）",
    has(tricky, "<title>&lt;x&gt;&amp;&quot;&#39;</title>"),
    snippet(tricky, "<title>"),
  );
  record(
    "转义函数覆盖五个字符",
    escapeHtmlText(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;",
    escapeHtmlText(`&<>"'`),
  );

  record("正文原样嵌入（不在这一步二次加工）", has(light, base.bodyHtml), snippet(light, "<h1"));
  record("传入的样式原样内联", has(light, base.css), snippet(light, ".markdown-body{color:red}"));
  record(
    "两段 <style> 都在：基础样式 + 应用样式",
    (light.match(/<style>/g) ?? []).length === 2,
    String((light.match(/<style>/g) ?? []).length),
  );
  record(
    "基础样式里有 @media print（导出物直接打印也不会带一堆内边距）",
    has(light, "@media print"),
    "",
  );
  record(
    "声明 color-scheme 两种形态，滚动条/表单控件颜色才不会错",
    has(light, "color-scheme:light") && has(light, "html.dark{color-scheme:dark}"),
    "",
  );

  // ⚠ 这里查的是**元素**而不是 "export-meta" 这个字符串：
  // 基础样式里本来就定义了 .export-meta 的规则，按字符串查会永远命中。
  record("不传 generatedAt 时没有导出时间行", !has(light, '<p class="export-meta">'), "");
  const stamped = buildStandaloneHtml({ ...base, generatedAt: "2026-10-11 01:30" });
  record(
    "传了 generatedAt 才渲染导出时间",
    has(stamped, "导出时间 2026-10-11 01:30"),
    snippet(stamped, "export-meta"),
  );
  const stampedTricky = buildStandaloneHtml({ ...base, generatedAt: "<b>" });
  record(
    "导出时间也走转义（同样是外部可控字符串）",
    has(stampedTricky, "导出时间 &lt;b&gt;"),
    snippet(stampedTricky, "导出时间"),
  );

  // 「自包含」是这份产物的核心承诺：任何 <script> 都是不可接受的
  record("成品里没有任何 <script 标签", !/<script/i.test(light), "");
}

// ------------------------------------------------------------ 2. 图片地址补全（纯函数）

function testMaterializeImages(): void {
  const single = materializeRelativeImages('<img alt="a" data-md-src="img/a.png" loading="lazy">');
  record(
    "相对路径补成 src，并去掉 data-md-src",
    single.count === 1 && has(single.html, 'src="img/a.png"') && !has(single.html, "data-md-src"),
    single.html,
  );
  record("补 src 时不动 alt / loading 等其它属性", has(single.html, 'alt="a"') && has(single.html, 'loading="lazy"'), single.html);

  const xss = materializeRelativeImages('<img data-md-src="javascript:alert(1)">');
  record(
    "javascript: 协议被拒绝、原样保留（不给自己留后门）",
    xss.count === 0 && has(xss.html, "javascript:alert(1)") && has(xss.html, "data-md-src"),
    xss.html,
  );

  const mixed = materializeRelativeImages(
    '<img data-md-src="a.png"><img data-md-src="https://x/b.png"><img src="c.png">',
  );
  record(
    "多张图片：只补 data-md-src 的那些，已有 src 的不碰",
    mixed.count === 2 && has(mixed.html, 'src="a.png"') && has(mixed.html, 'src="https://x/b.png"'),
    `count=${mixed.count}`,
  );

  record(
    "没有图片时不改动内容",
    materializeRelativeImages("<p>纯文本</p>").html === "<p>纯文本</p>",
    "",
  );
}

// ------------------------------------------------------------ 3. 默认文件名

function testDefaultExportName(): void {
  record("Windows 反斜杠路径取主干名", defaultExportName("D:\\笔记\\周报.md") === "周报.html", defaultExportName("D:\\笔记\\周报.md"));
  record("正斜杠路径同样可以", defaultExportName("/home/x/a.markdown") === "a.html", defaultExportName("/home/x/a.markdown"));
  record("没有源文件时用「未命名文档」", defaultExportName(null) === "未命名文档.html", defaultExportName(null));
  record("没有扩展名时补 .html", defaultExportName("D:\\x\\readme") === "readme.html", defaultExportName("D:\\x\\readme"));
  record(
    "只切最后一个扩展名：a.b.md → a.b.html",
    defaultExportName("D:\\x\\a.b.md") === "a.b.html",
    defaultExportName("D:\\x\\a.b.md"),
  );
}

// ------------------------------------------------------------ 4. 样式提取（真实样式表）

function testPickExportCss(): void {
  const css = pickExportCss();

  record("提取结果非空 —— 空的话导出的文件毫无排版", css.length > 0, `${css.length} 字符`);
  record("带出了颜色令牌 --preview-bg", has(css, "--preview-bg"), snippet(css, "--preview-bg"));
  record("带出了 --foreground（正文颜色靠它）", has(css, "--foreground"), snippet(css, "--foreground"));
  record("带出了 .markdown-body 排版", has(css, ".markdown-body"), snippet(css, ".markdown-body"));
  record("带出了代码高亮配色 .hljs-*", has(css, ".hljs-comment"), snippet(css, ".hljs-comment"));
  record("带出了暗色令牌（.dark 那一块）", has(css, ".dark"), snippet(css, ".dark"));

  // 反向断言同样重要：多带 = 把编辑器外壳样式塞进别人的页面
  record("没有误带编辑器样式 .cm-editor", !has(css, ".cm-editor"), snippet(css, ".cm-editor"));
  record("没有误带应用根容器 #root", !has(css, "#root"), snippet(css, "#root"));
  record(
    "自包含：样式里没有任何 http(s) 外链资源",
    !/url\(\s*['"]?(?:https?|file):/i.test(css),
    snippet(css, "url("),
  );
}

// ------------------------------------------------------------ 5. 端到端

async function testEndToEnd(): Promise<void> {
  const markdown = [
    "# 标题",
    "",
    "正文里有**粗体**和[外链](https://example.com)。",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "![图](img/a.png)",
    "",
    "<script>alert(1)</script>",
  ].join("\n");

  const body = await renderSanitizedHtml(markdown);

  record("标题渲染成 <h1> 且带锚点 id", /<h1 id="/.test(body), snippet(body, "<h1"));
  record("代码块带 hljs 高亮类", has(body, "hljs"), snippet(body, "hljs"));
  record("代码块标了语言 language-js", has(body, "language-js"), snippet(body, "language-js"));
  record("链接带 data-md-link 标记（仍是「不在 WebView 内导航」那一套）", has(body, "data-md-link"), "");
  record(
    "原始 <script> 被转义成文本，没有真的产生脚本标签",
    !/<script/i.test(body) && has(body, "&lt;script&gt;"),
    snippet(body, "script"),
  );

  const finalHtml = buildStandaloneHtml({
    title: "端到端",
    bodyHtml: materializeRelativeImages(body).html,
    css: pickExportCss(),
    dark: true,
  });

  record("成品里同样没有 <script>", !/<script/i.test(finalHtml), "");
  record("成品里内联了 .markdown-body 样式", has(finalHtml, ".markdown-body"), "");
  record("成品里不再残留 data-md-src", !has(finalHtml, 'data-md-src="img/a.png"'), "");
  record("成品里图片写上了相对路径 src", has(finalHtml, 'src="img/a.png"'), snippet(finalHtml, "img/a.png"));
  record(
    "成品是完整的 HTML 文档（doctype + </html> 都在）",
    finalHtml.startsWith("<!doctype html>") && finalHtml.trimEnd().endsWith("</html>"),
    "",
  );
  // 文件大小是用户能感知的成本：样式内联进来会让它涨，但不该失控
  record(
    "成品体积在合理区间（< 512 KB，纯文本不该更大）",
    finalHtml.length < 512 * 1024,
    `${(finalHtml.length / 1024).toFixed(1)} KB`,
  );
}

// ------------------------------------------------------------ 6. 真渲染（iframe）

/**
 * 把导出物塞进一个同源 iframe 里真跑一遍，读计算样式。
 *
 * 上面「字符串里有这行 CSS」只能证明**写了**，证明不了**有用**：
 * 选择器写错、变量没定义、被后面的规则覆盖，字符串断言全都是绿的。
 * 只有让浏览器真的排版一遍，把 computed style 读出来，才叫验过了。
 *
 * 用 srcdoc 而不是 blob:/data: —— srcdoc 被当作同源，dev 的 CSP
 * （style-src 里带 'unsafe-inline'）放行内联 <style>，而导出物里本来就没有脚本。
 */
async function placeInIframe(html: string): Promise<{ doc: Document; win: Window }> {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:700px;border:0";
  document.body.append(frame);

  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  frame.srcdoc = html;
  await loaded;

  return { doc: frame.contentDocument as Document, win: frame.contentWindow as Window };
}

/**
 * 取 body 计算后的背景色字符串。
 *
 * ⚠ 不要试图解析成 RGB：本项目用的是 `oklch()`，Chrome 计算后序列化成
 * `lab(96.52 ...)` 这类形式，按 `rgb()` 正则去解会一律拿不到（第一版就是这么挂的）。
 * 这里只关心两件事：解析出来了没有、深浅两版是不是真的不同。
 */
function resolvedBackground(win: Window, el: Element): string {
  return win.getComputedStyle(el).backgroundColor;
}

async function testRenderedOutput(): Promise<void> {
  const markdown = [
    "# 大标题",
    "",
    "正文一段。",
    "",
    "```js",
    "const a = 1;",
    "```",
  ].join("\n");

  const body = await renderSanitizedHtml(markdown);
  const css = pickExportCss();
  const make = (dark: boolean): string =>
    buildStandaloneHtml({ title: "真渲染", bodyHtml: body, css, dark });

  const light = await placeInIframe(make(false));
  const h1 = light.doc.querySelector("h1");
  if (!h1) {
    record("iframe 里能拿到渲染后的 h1", false, "没找到 h1");
    return;
  }
  record("iframe 里渲染出了正文结构", !!light.doc.querySelector(".markdown-body"), "");

  const h1Style = light.win.getComputedStyle(h1);
  record(
    "h1 被样式表放大（证明提取的样式真的参与排版，而不只是被写进文件）",
    Number.parseFloat(h1Style.fontSize) >= 24,
    `font-size=${h1Style.fontSize}`,
  );
  record("h1 是粗体", Number(h1Style.fontWeight) >= 600, `font-weight=${h1Style.fontWeight}`);

  const pre = light.doc.querySelector("pre");
  record(
    "代码块有底色（.markdown-body pre 的规则生效了）",
    !!pre && resolvedBackground(light.win, pre) !== "rgba(0, 0, 0, 0)",
    pre ? resolvedBackground(light.win, pre) : "没有 pre",
  );

  const lightBg = resolvedBackground(light.win, light.doc.body);
  record(
    "浅色：正文底色解析出了真实颜色（--preview-bg 生效，没落到透明）",
    lightBg.length > 0 && lightBg !== "rgba(0, 0, 0, 0)",
    lightBg,
  );

  const deep = await placeInIframe(make(true));
  const deepBg = resolvedBackground(deep.win, deep.doc.body);
  record(
    "深色：正文底色与浅色版不同（.dark 令牌确实被带进导出文件了）",
    deepBg.length > 0 && deepBg !== lightBg,
    `${lightBg} → ${deepBg}`,
  );

  // 直接从样式文本上再确认一次：--preview-bg 在导出文件里有两个不同的取值，
  // 对应 :root 与 .dark 两套令牌。这条不依赖浏览器怎么序列化颜色。
  const values = [...css.matchAll(/--preview-bg:\s*([^;]+);/g)].map((m) => m[1]?.trim() ?? "");
  const distinct = new Set(values.filter(Boolean));
  record(
    "样式文本里 --preview-bg 有两套不同的取值（:root 与 .dark 都在）",
    distinct.size >= 2,
    [...distinct].join(" | ") || "没有匹配到",
  );
}

// ------------------------------------------------------------ 导出样例出口

/**
 * 给 `dev/make-sample-export.mjs` 用的一次性出口。
 *
 * 存在的理由：验收断言能证明「符合预期」，但证明不了「看起来对」。
 * 让驱动器把一段真实 Markdown 走完整条管线、把成品落盘，人眼过一遍，
 * 这两件事是互补的，不能互相替代。
 */
(window as unknown as Record<string, unknown>).__sampleExport = async (
  markdown: string,
  dark: boolean,
): Promise<string> => {
  const body = await renderSanitizedHtml(markdown);
  return buildStandaloneHtml({
    title: "导出样例",
    bodyHtml: materializeRelativeImages(body).html,
    css: pickExportCss(),
    dark,
    generatedAt: new Date().toLocaleString("zh-CN"),
  });
};

// ------------------------------------------------------------ 收尾

function finish(): void {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;

  const lines = [
    ...results.map(
      (r, i) =>
        `${r.pass ? "PASS" : "FAIL"} ${String(i + 1).padStart(2, "0")} ${r.name}${r.info ? ` | ${r.info}` : ""}`,
    ),
    "",
    `STEPS ${steps.join(" → ")}`,
    "",
    `SUMMARY pass=${pass} fail=${fail} total=${results.length}`,
  ];

  const out = document.createElement("pre");
  out.id = "out";
  out.style.cssText = "position:fixed;left:0;bottom:0;z-index:9999;font-size:12px;white-space:pre-wrap";
  out.textContent = lines.join("\n");
  document.body.append(out);
  document.title = fail === 0 ? `ALL_PASS ${pass}/${results.length}` : `HAS_FAILURES ${fail}`;
}

setTimeout(() => finish(), 75000);

async function main(): Promise<void> {
  try {
    step("buildStandaloneHtml");
    testBuildStandaloneHtml();
    step("materializeImages");
    testMaterializeImages();
    step("defaultExportName");
    testDefaultExportName();
    step("pickExportCss");
    testPickExportCss();
    step("endToEnd");
    await testEndToEnd();
    step("renderedOutput");
    await testRenderedOutput();
    step("done");
  } catch (err) {
    record("验收脚本自身异常", false, String(err));
    console.error(err);
  }

  finish();
}

void main();
