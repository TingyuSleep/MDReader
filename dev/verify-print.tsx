/**
 * 批次 11 的验收脚本：打印。用完即删。
 *
 * 分三层验，因为这三层「挂掉的样子」完全不同：
 *
 *   1. **打印样式**（纯函数）。`@page` 少了是满纸贴边；`overflow` 没还原是
 *      **只印得出第一页**；隐藏外壳那条写错，要么连正文一起藏了，要么把工具栏也印上。
 *      这些全在字符串层面，逐条钉死比"打出来看看"可靠得多。
 *
 *   2. **浅色令牌提取 + 挂载 / 卸载**。必须在真实样式表上验：`.dark` 的令牌挂在
 *      `<html>` 上，能不能被压掉，光看 TS 代码看不出来，得拿真正的 CSSOM 说话。
 *      挂载/卸载则覆盖两个最容易漏的点 —— 屏幕上不能看见打印容器（否则文档底部会
 *      多出一份没排版的正文），清理必须幂等（否则第二次打印会叠两个容器）。
 *
 *   3. **端到端**。真的把一段 Markdown 走完整条管线，并 stub 掉 `window.print()`
 *      验「打印时容器在、打印后容器没了」。**容器与样式表任缺一个，屏幕上都不露异常，
 *      只有印出来才发现是白纸** —— 所以这两条是本套件最重要的断言。
 *
 * 打印媒体下到底能不能正确分页、外壳是不是真的被藏了，页面里量不到（改不了媒体类型）。
 * 那一层交给运行器在 CDP 的 `Emulation.setEmulatedMedia({media:"print"})` 下验，
 * 见 dev/verify-runner.mjs 的「打印媒体探针」阶段 —— 页面这边只负责把探针口子
 * (`__printMediaProbe` / `__printMediaCleanup`) 挂到 window 上。
 */
// 验收构建没有 index.html 入口，必须显式引主题，否则拿不到 :root / .dark 两套令牌
import "@/index.css";

import { pickLightTokenDeclarations, renderSanitizedHtml } from "@/lib/export-html";
import {
  buildPrintCss,
  disposePrintSession,
  mountPrintRoot,
  printDocument,
  PRINT_ROOT_ID,
  PRINT_STYLE_ID,
  type PrintSession,
} from "@/lib/print";

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

/** 断言辅助：把「包含 / 不包含」写短一点 */
const has = (haystack: string, needle: string): boolean => haystack.includes(needle);

/** 失败信息里带上真实片段，否则只看一句 FAIL 完全不知道该改哪儿 */
const snippet = (text: string, needle: string): string => {
  const idx = text.indexOf(needle);
  if (idx < 0) return `未找到 ${JSON.stringify(needle)}`;
  return JSON.stringify(text.slice(Math.max(0, idx - 30), idx + needle.length + 30));
};

const byId = (id: string): HTMLElement | null => document.getElementById(id);

// ------------------------------------------------------------ 样例

const SAMPLE = [
  "# 打印验收样例",
  "",
  "正文里有中文、English words、数字 12345 和 `行内代码`。",
  "",
  "## 列表",
  "",
  "- 无序项 **加粗**",
  "- [x] 已完成的任务",
  "- [ ] 待办事项",
  "",
  "## 表格",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "## 引用",
  "",
  "> 引用里的 `代码`",
  "",
  "## 代码块",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
  "",
  "![本地图](./pic.png)",
  "",
].join("\n");

const XSS = [
  "<script>window.__pwned = 1;</script>",
  "",
  "<img src=x onerror=\"window.__pwned = 2\">",
  "",
  "[点我](javascript:window.__pwned=3)",
  "",
  "<iframe src=\"https://example.com\"></iframe>",
  "",
  "[锚点](#section)",
].join("\n");

// ------------------------------------------------------------ 1. 打印样式（纯函数）

function testBuildPrintCss(): void {
  const css = buildPrintCss("--preview-bg: oklch(1 0 0);");

  record("打印样式里有 @page 规则", has(css, "@page"), snippet(css, "@page"));
  record("@page 指定了页边距（不贴边）", /@page\{[^}]*margin:/.test(css));

  // 这两条是"只印一页"这个 bug 的唯一防线，必须逐条盯住
  record("还原了 html/body 的 height（外壳是 height:100%，不还原只印一屏）", /html,body\{[^}]*height:auto!important/.test(css));
  record("还原了 html/body 的 overflow（外壳是 overflow:hidden，不还原只印一屏）", /html,body\{[^}]*overflow:visible!important/.test(css));
  record("强制 html/body 底色为白", /html,body\{[^}]*background:#fff!important/.test(css));

  record(
    "除了打印容器，body 下的直接子元素一律不印",
    has(css, `body > *:not(#${PRINT_ROOT_ID}){display:none!important}`),
    snippet(css, "body > *"),
  );
  record(
    "打印容器被强制显示（内联 display:none 靠这条 !important 才能露出来）",
    css.includes(`#${PRINT_ROOT_ID}{\ndisplay:block!important;`) || /#md-print-root\{[^}]*display:block!important/m.test(css),
  );
  record(
    "打印容器配色走令牌而不是写死颜色",
    has(css, "background:var(--preview-bg") && has(css, "color:var(--foreground"),
  );
  record("保留代码块/表格底色（print-color-adjust:exact）", has(css, "print-color-adjust:exact"));

  const missingHeading = ["h1", "h2", "h3", "h4", "h5", "h6"].filter(
    (tag) => !has(css, `#${PRINT_ROOT_ID} ${tag}`),
  );
  record("六个标题都设了 break-after（标题不孤零零留在页尾）", missingHeading.length === 0, missingHeading.join(","));

  const missingAtomic = ["pre", "blockquote", "table", "img", "tr"].filter(
    (tag) => !has(css, `#${PRINT_ROOT_ID} ${tag}`),
  );
  record("代码块/引用/表格/图片/表格行都设了 break-inside（不被拦腰截断）", missingAtomic.length === 0, missingAtomic.join(","));

  record(
    "表格跨页时重复表头",
    css.includes(`#${PRINT_ROOT_ID} thead{display:table-header-group}`),
  );

  // 不传令牌时不能留下一条空规则 —— 空规则会让"为什么这里有个 #md-print-root"变得难以理解
  const withoutTokens = buildPrintCss();
  const emptyTokenRule = new RegExp(`#${PRINT_ROOT_ID}\\{\\s*\\}`).test(withoutTokens);
  record("不传浅色令牌时不生成空规则", !emptyTokenRule);
}

// ------------------------------------------------------------ 2. 浅色令牌提取

function readToken(name: string, dark: boolean): string {
  document.documentElement.classList.toggle("dark", dark);
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  document.documentElement.classList.remove("dark");
  return value;
}

function testLightTokens(): void {
  const tokens = pickLightTokenDeclarations(document);

  record("从真实样式表里抽到了 :root 的声明", tokens.length > 0, `${tokens.length} 字符`);
  record("抽到的东西里有 --preview-bg", has(tokens, "--preview-bg:"));
  record("抽到的东西里有 --foreground", has(tokens, "--foreground:"));

  // 只认选择器恰好等于 :root 的规则。要是把 .dark 也收进来了，打印就又变回深色了。
  const darkOnly = readToken("--preview-bg", true);
  const lightValue = tokens.match(/--preview-bg:\s*([^;]+);/)?.[1]?.trim() ?? "";
  record(
    "抽取结果不含 .dark 的深色取值（只认选择器恰好是 :root 的规则）",
    lightValue.length > 0 && lightValue !== darkOnly,
    `抽样 ${lightValue} / 深色 ${darkOnly}`,
  );
  record(
    "浅色与深色的 --preview-bg 取值确实不同（否则上面那条断言没意义）",
    lightValue.length > 0 && darkOnly.length > 0 && lightValue !== darkOnly,
  );

  // 挂到 ID 选择器上才有意义：靠特异性（1-0-0）压过 html.dark（0-1-1）。
  // 只看最后那条 #md-print-root 规则里有没有令牌 —— 主规则里的
  // `background:var(--preview-bg,#fff)` 只有 "preview-bg"（没有冒号），不会误判。
  const css = buildPrintCss(tokens);
  const tail = css.slice(css.lastIndexOf(`#${PRINT_ROOT_ID}{`));
  record(
    "令牌被重挂到 #md-print-root 上，而不是重新声明一次 :root",
    tail.includes("--preview-bg:") && tail.includes("--foreground:") && !/^:root\{/m.test(tail),
    `${tail.length} 字符的令牌块`,
  );
}

// ------------------------------------------------------------ 3. 挂载 / 卸载

function testMountRoot(): void {
  const session = mountPrintRoot("<h1>标题</h1><p>正文</p>");

  const root = byId(PRINT_ROOT_ID);
  const style = byId(PRINT_STYLE_ID);

  record("挂载后有打印容器", root !== null);
  record("打印容器是 body 的直接子元素（塞进 #root 里会被外壳隐藏规则一起藏掉）", root?.parentElement === document.body);
  record("容器内有 article.markdown-body（复用应用正文排版）", session.article.tagName === "ARTICLE" && session.article.classList.contains("markdown-body"));

  // ⚠ 这两条是本套件的核心：样式表或容器任缺一个，屏幕上都不露异常，只有印出来才知道
  record("挂载后有打印样式表", style !== null);
  record("打印样式表带 media=print（不带的话屏幕上界面会立刻被藏掉）", style?.getAttribute("media") === "print");
  record("打印样式表内容非空且含 @page", (style?.textContent ?? "").includes("@page"));

  // 屏幕上必须看不见：@media print 之外打印样式完全不生效，靠内联 display:none 兜
  record(
    "屏幕上打印容器不可见（否则文档底部会多出一份没排版的正文）",
    root !== null && getComputedStyle(root).display === "none",
    root ? getComputedStyle(root).display : "无容器",
  );

  // 幂等：上一次打印异常退出留下的残骸要先收掉，否则会叠容器
  const again = mountPrintRoot("<p>第二份</p>");
  record("重复挂载是幂等的（不会叠出两个容器）", document.querySelectorAll(`#${PRINT_ROOT_ID}`).length === 1);
  record("重复挂载是幂等的（不会叠出两个样式表）", document.querySelectorAll(`#${PRINT_STYLE_ID}`).length === 1);
  record("重复挂载后容器里是新的正文", again.article.textContent === "第二份");

  again.dispose();
  record("dispose 后容器被移除", byId(PRINT_ROOT_ID) === null);
  record("dispose 后样式表被移除", byId(PRINT_STYLE_ID) === null);

  disposePrintSession();
  let disposeTwiceOk = true;
  try {
    disposePrintSession();
  } catch {
    disposeTwiceOk = false;
  }
  record("dispose 可以重复调用且不抛错（清理路径必须幂等）", disposeTwiceOk);

  session.dispose();
}

// ------------------------------------------------------------ 4. 内容保真与清洗

async function testContent(): Promise<void> {
  const bodyHtml = await renderSanitizedHtml(SAMPLE);
  const session = mountPrintRoot(bodyHtml);
  const article = session.article;

  record("标题渲染成 h1", article.querySelector("h1")?.textContent === "打印验收样例");
  record("二级标题数量正确", article.querySelectorAll("h2").length === 4);
  record("表格渲染成 table", article.querySelector("table") !== null);
  record("任务列表渲染出两个复选框", article.querySelectorAll('input[type="checkbox"]').length === 2);
  record("已完成的任务被勾上", article.querySelector('input[type="checkbox"][checked]') !== null);
  record("引用块渲染成 blockquote", article.querySelector("blockquote") !== null);
  record("代码块渲染成 pre.md-code-block", article.querySelector("pre.md-code-block") !== null);
  record(
    "代码块带语法高亮 span（否则打印出来是一片纯色文字）",
    article.querySelectorAll("pre.md-code-block .hljs-keyword, pre.md-code-block .hljs-number, pre.md-code-block .hljs-title").length > 0,
    `${article.querySelectorAll("pre.md-code-block span").length} 个 span`,
  );
  record("行内代码渲染成 code", article.querySelector("p code") !== null);
  record("图片保留 data-md-src（不传 baseDir 时不擅自猜路径）", article.querySelector("img")?.getAttribute("data-md-src") === "./pic.png");

  session.dispose();

  // ---- 清洗：打印容器用的是 renderSanitizedHtml 的产物，安全边界必须和 Preview 一致
  const dirty = await renderSanitizedHtml(XSS);
  const dirtySession = mountPrintRoot(dirty);
  const node = dirtySession.article;

  record("没有 script 元素", node.querySelector("script") === null);
  record("没有 iframe 元素（生产 CSP 也是 frame-src 'none'）", node.querySelector("iframe") === null);
  record("没有 onerror 之类的内联事件属性", node.querySelector("[onerror]") === null);
  record(
    "没有 javascript: 链接",
    Array.from(node.querySelectorAll("a")).every((a) => !/^javascript:/i.test(a.getAttribute("href") ?? "")),
  );
  record("XSS 载荷没有执行", (window as unknown as Record<string, unknown>).__pwned === undefined);
  record("锚点链接被保留（不能为了安全把所有链接都删掉）", node.querySelector('a[href^="#"]') !== null);

  dirtySession.dispose();
}

// ------------------------------------------------------------ 5. 端到端（stub window.print）

async function testPrintDocument(): Promise<void> {
  const originalPrint = window.print;
  let calls = 0;
  let mountedDuringPrint = false;
  let styledDuringPrint = false;

  const stub = (): void => {
    calls += 1;
    mountedDuringPrint = byId(PRINT_ROOT_ID) !== null;
    styledDuringPrint = byId(PRINT_STYLE_ID) !== null;
  };

  window.print = stub;
  try {
    const bodyBefore = document.body.children.length;

    const outcome = await printDocument({ markdown: SAMPLE, baseDir: undefined });

    record("打印返回 printed", outcome.status === "printed", JSON.stringify(outcome));
    record("window.print 被调用了恰好一次", calls === 1, `${calls} 次`);
    record("调用 print 的那一刻容器已经在 DOM 里", mountedDuringPrint);
    record("调用 print 的那一刻打印样式表已经挂上", styledDuringPrint);
    record("打印结束后容器被清理（不做的话下一次会叠容器）", byId(PRINT_ROOT_ID) === null);
    record("打印结束后样式表被清理", byId(PRINT_STYLE_ID) === null);
    record("打印过程没有动应用外壳（body 子元素数量不变）", document.body.children.length === bodyBefore, `${bodyBefore} → ${document.body.children.length}`);

    // ---- 空文档：不该白弹一次系统打印对话框
    calls = 0;
    const empty = await printDocument({ markdown: "   \n\n  " });
    record("空白内容返回 nothing", empty.status === "nothing", JSON.stringify(empty));
    record("空白内容不会调起打印对话框", calls === 0, `${calls} 次`);
    record("空白内容也不会留下容器", byId(PRINT_ROOT_ID) === null);

    // ---- print 抛错：必须向上抛（不能静默），但清理照做
    calls = 0;
    window.print = () => {
      calls += 1;
      throw new Error("模拟打印对话框异常");
    };
    let threw = false;
    let message = "";
    try {
      await printDocument({ markdown: SAMPLE });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    record("window.print 抛错时异常向上抛（不静默吞掉）", threw, message);
    record("抛错时容器与样式表依然被清理（try/finally 生效）", byId(PRINT_ROOT_ID) === null && byId(PRINT_STYLE_ID) === null);
    record("抛错时清理只做了一次、没误删别的节点", document.body.children.length === bodyBefore);
  } finally {
    window.print = originalPrint;
  }
}

// ------------------------------------------------------------ 打印媒体探针（给运行器用）

const PROBE_SAMPLE = [
  "# 打印媒体探针",
  "",
  ...Array.from({ length: 6 }, (_, i) => [
    `## 第 ${i + 1} 节`,
    "",
    "这一段是拿来把版面撑到两页以上的。打印媒体的分页规则是否生效，",
    "只有在真的产出多页结果时才有意义 —— 一页纸看不出 break-inside 有没有用。",
    "",
    "- 列表项一",
    "- 列表项二",
    "",
    "| 列 | 值 |",
    "| --- | --- |",
    `| 节 | ${i + 1} |`,
    "",
    "```ts",
    `const section = ${i + 1};`,
    "```",
    "",
  ].join("\n")),
].join("\n");

interface ProbeResult {
  name: string;
  pass: boolean;
  info: string;
}

/**
 * 在**打印媒体**下量一次真实版面。
 *
 * 运行器负责先调 `Emulation.setEmulatedMedia({media:"print"})` 再调这里 ——
 * 页面自己改不了媒体类型，所以这段断言必须由外面配合才能跑。
 *
 * **刻意不 dispose**：运行器紧接着要用 `Page.printToPDF` 抓这份版面存成样例，
 * 抓完再调 `__printMediaCleanup`。
 */
(window as unknown as Record<string, unknown>).__printMediaProbe = async (): Promise<ProbeResult[]> => {
  const found: ProbeResult[] = [];
  const note = (name: string, pass: boolean, info = ""): void => {
    found.push({ name, pass, info });
  };

  const bodyHtml = await renderSanitizedHtml(PROBE_SAMPLE);
  const session: PrintSession = mountPrintRoot(bodyHtml);
  const rootStyle = getComputedStyle(session.root);

  const out = byId("out");
  const outDisplay = out ? getComputedStyle(out).display : "无 #out";

  note("打印媒体下打印容器可见", rootStyle.display !== "none", rootStyle.display);
  note("打印媒体下验收脚本自身的输出被隐藏（外壳隐藏规则真的生效）", outDisplay === "none", outDisplay);
  note(
    "打印媒体下容器有实际宽度（正文真的排上了版，不是 0 宽）",
    session.root.getBoundingClientRect().width > 0,
    `${Math.round(session.root.getBoundingClientRect().width)}px`,
  );
  note(
    "打印媒体下应用外壳被隐藏（body 下只剩打印容器可见）",
    Array.from(document.body.children).every(
      (el) => el.id === PRINT_ROOT_ID || getComputedStyle(el).display === "none",
    ),
  );

  // ---- 深色主题下也必须印成浅色
  //
  // ⚠ 不要在 TS 里写死颜色去比。这个项目用的是 oklch()，Chrome 计算后可能序列化成
  // lab()/oklab() —— 拿 rgb 正则或写死的字符串去比一定对不上（批次 10 踩过一次）。
  // 正确做法：把令牌值挂到一个临时元素上，让**同一个序列化器**给出基准值再比。
  const resolveToken = (cssValue: string, property: "background" | "color"): string => {
    const probe = document.createElement("div");
    probe.style[property] = cssValue;
    document.body.append(probe);
    const resolved = getComputedStyle(probe)[property === "background" ? "backgroundColor" : "color"];
    probe.remove();
    return resolved;
  };

  const lightBgToken = readToken("--preview-bg", false);
  const darkBgToken = readToken("--preview-bg", true);
  const lightBg = resolveToken(lightBgToken, "background");
  const lightFg = resolveToken(readToken("--foreground", false), "color");

  /*
    真正的判据不是"某个元素的颜色等于某个令牌"，而是
    **深色主题下打印出来的配色和浅色主题下完全一样**。

    一开始这里写的是"h1 的颜色等于浅色 --foreground"，直接红了 ——
    标题的配色走的是 --cm-heading（蓝紫），根本不经过 --foreground。
    与其给每种元素记一份"它用哪个令牌"，不如两边各测一遍直接比：
    这条断言对标题、正文、代码块一视同仁，将来谁改了令牌都不会假绿。
  */
  const heading = session.article.querySelector("h1");
  const backgroundLight = getComputedStyle(session.root).backgroundColor;
  const articleLight = getComputedStyle(session.article).color;
  const headingLight = heading ? getComputedStyle(heading).color : "";

  document.documentElement.classList.add("dark");
  const backgroundDark = getComputedStyle(session.root).backgroundColor;
  const articleDark = getComputedStyle(session.article).color;
  const headingDark = heading ? getComputedStyle(heading).color : "";
  document.documentElement.classList.remove("dark");

  note("浅色与深色的 --preview-bg 确实不同（否则下面几条没意义）", lightBgToken !== darkBgToken, `${lightBgToken} | ${darkBgToken}`);
  note(
    "深色主题下打印容器底色仍是浅色（#md-print-root 的令牌压过了 html.dark）",
    backgroundDark === lightBg && backgroundDark === backgroundLight,
    `深色主题实测 ${backgroundDark} / 浅色实测 ${backgroundLight}`,
  );
  note(
    "深色主题下正文文字仍是浅色主题的文字色（不会白字白纸）",
    articleDark === articleLight && articleDark === lightFg,
    `深色主题实测 ${articleDark} / 浅色实测 ${articleLight}`,
  );
  note(
    "深色主题下标题配色不变（标题走的是 --cm-heading，不是 --foreground）",
    heading !== null && headingDark === headingLight && headingLight.length > 0,
    `深色主题实测 ${headingDark} / 浅色实测 ${headingLight}`,
  );

  return found;
};

/** 探针收尾：把留给 PDF 的打印版面拆掉，别让它留在页面上 */
(window as unknown as Record<string, unknown>).__printMediaCleanup = (): boolean => {
  disposePrintSession();
  return byId(PRINT_ROOT_ID) === null && byId(PRINT_STYLE_ID) === null;
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
    step("buildPrintCss");
    testBuildPrintCss();
    step("lightTokens");
    testLightTokens();
    step("mountRoot");
    testMountRoot();
    step("content");
    await testContent();
    step("printDocument");
    await testPrintDocument();
    step("done");
  } catch (err) {
    record("验收脚本自身异常", false, String(err));
    console.error(err);
  }

  finish();
}

void main();
