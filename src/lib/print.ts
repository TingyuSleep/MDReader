/**
 * 打印。
 *
 * 和「导出 HTML」**共用同一条渲染管线**（markdown-it → DOMPurify → markdown-sanitize），
 * 但产物形态刻意不同：
 *
 *   - 导出：生成一个**会离开本文档**的自包含文件，样式必须内联进去。
 *   - 打印：就在**当前文档里**印，应用的样式表本来就挂着，一行都不用抄，
 *     只需要一小段 `@media print` 把应用外壳藏起来、把打印容器露出来。
 *
 * 不给打印造 iframe 是有意的：生产 CSP 是 `frame-src 'none'`，
 * `srcdoc` iframe 是否放行取决于浏览器实现，不能拿打印这种主功能去赌。
 *
 * 三个必须做对的点：
 *
 * 1. **深色主题下也要印成浅色。** 白纸上一整片深灰底既费墨又难读。但 `.dark`
 *    的令牌挂在 `<html>` 上，只改打印容器的颜色没用 —— `.dark{...}` 那条规则还在生效。
 *    解法是把样式表里 `:root` 的声明**原样**重挂到 `#md-print-root` 这个 ID 选择器上，
 *    靠特异性（1-0-0 > 0-1-0）压过 `html.dark`。见 pickLightTokenDeclarations。
 *
 * 2. **`overflow: hidden` 会让打印只有一页。** 应用外壳是
 *    `html,body,#root{height:100%}` + `body{overflow:hidden}`（桌面应用不该出现整页滚动条），
 *    不还原的话浏览器认为内容只有一屏，无论正文多长都只印第一页。
 *
 * 3. **打印样式表与打印容器必须成对清理。** 容器用的是内联 `display:none`，
 *    只有打印样式表里那条 `display:block !important` 能让它露出来 ——
 *    也就是说这两个东西任缺一个，屏幕上都不会看见异常，只有"打印出来是空的"。
 *    这种故障只能靠 try/finally 保证，不能靠"记得删"。
 */
import { resolveAssetImages } from "./asset-images";
import { pickLightTokenDeclarations, renderSanitizedHtml } from "./export-html";

/** 打印容器的 id。打印样式表全靠它做选择器，改这里等于改样式，别只改一处。 */
export const PRINT_ROOT_ID = "md-print-root";
/** 打印样式表的 id，只用于卸载 */
export const PRINT_STYLE_ID = "md-print-style";

/**
 * 全局快捷键想触发打印时，往 window 上发这个事件。
 *
 * 和 Ctrl+F 同一套做法（见 Editor.tsx 的 TOGGLE_FIND_EVENT）：
 * 快捷键注册在 App、打印实现和按钮一起在 Toolbar，两边不互相 import 组件。
 */
export const REQUEST_PRINT_EVENT = "mdreader:request-print";

// ------------------------------------------------------------ 打印样式（纯函数）

/**
 * 拼打印样式。
 *
 * 只装"专属于打印"的东西，正文排版一条都不抄 —— 那些规则本来就在文档的样式表里，
 * 抄一遍就等于给自己留一处必然会漂移的副本。
 *
 * 纯函数，因此可以被逐条断言。
 */
export function buildPrintCss(lightTokens = ""): string {
  const tokens = lightTokens.trim();

  // 标题不能孤零零留在页尾（break-after: avoid），代码块/表格/图片不能被拦腰截断。
  // 两条 page-break-* 是给老内核的别名，成本为零，留着。
  const headings = ["h1", "h2", "h3", "h4", "h5", "h6"]
    .map((tag) => `#${PRINT_ROOT_ID} ${tag}`)
    .join(",");
  const atomic = ["pre", "blockquote", "table", "img", "tr"]
    .map((tag) => `#${PRINT_ROOT_ID} ${tag}`)
    .join(",");

  // 令牌块放在最后：虽然自定义属性的解析与声明顺序无关，
  // 但把它独立成一条规则、单独一行注释，是为了让人一眼看出"高特异性覆盖"这件事。
  const tokenBlock = tokens
    ? `\n/* 浅色令牌重挂到打印容器：ID 特异性压过 html.dark，深色主题下也印成浅色 */\n#${PRINT_ROOT_ID}{\n${tokens}\n}\n`
    : "";

  return `@page{margin:16mm 15mm}
/* 外壳是 height:100% + overflow:hidden，不还原就只印得出一页 */
html,body{height:auto!important;overflow:visible!important;background:#fff!important}
/* 除了打印容器，body 下的东西（应用外壳、验收脚本的输出）一律不印 */
body > *:not(#${PRINT_ROOT_ID}){display:none!important}
#${PRINT_ROOT_ID}{
display:block!important;
box-sizing:border-box;
background:var(--preview-bg,#fff);
color:var(--foreground,#161616);
print-color-adjust:exact;
-webkit-print-color-adjust:exact;
}
${headings}{break-after:avoid-page;page-break-after:avoid}
${atomic}{break-inside:avoid;page-break-inside:avoid}
/* 表格跨页时重复表头，否则第二页起是一堆没有列名的数字 */
#${PRINT_ROOT_ID} thead{display:table-header-group}
#${PRINT_ROOT_ID} tfoot{display:table-footer-group}
${tokenBlock}`;
}

// ------------------------------------------------------------ 挂载 / 卸载（碰 DOM）

export interface PrintSession {
  /** 打印容器（body 的直接子元素） */
  readonly root: HTMLElement;
  /** 容器内的 article.markdown-body */
  readonly article: HTMLElement;
  /** 幂等，可重复调用 */
  dispose(): void;
}

/** 清掉上一次可能残留的容器与样式表。重复调用无副作用。 */
export function disposePrintSession(doc: Document = document): void {
  doc.getElementById(PRINT_ROOT_ID)?.remove();
  doc.getElementById(PRINT_STYLE_ID)?.remove();
}

/**
 * 把已清洗的正文挂成一个独立的打印容器。
 *
 * 两个刻意的选择：
 *
 * - 容器是 **body 的直接子元素**，不是 `#root` 里。打印样式靠
 *   `body > *:not(#md-print-root)` 隐藏外壳，塞进 `#root` 里就会被一起隐藏。
 * - 容器内联 `display:none`。`@media print` 之外打印样式**完全不生效**，
 *   所以要不加这一行，屏幕上文档底部会多出一份没样式、没排版的正文。
 *   打印时由样式表里那条 `display:block !important` 把它露出来
 *   （`!important` 的作者样式压得过内联样式）。
 *
 * `bodyHtml` 必须**已经过 DOMPurify**（由 renderSanitizedHtml 保证）。
 * 本函数不做任何清洗，与 Preview.tsx 是同一套安全边界。
 */
export function mountPrintRoot(
  bodyHtml: string,
  options: { baseDir?: string; doc?: Document } = {},
): PrintSession {
  const doc = options.doc ?? document;

  // 幂等：上一次打印如果异常退出留下残骸，这里先收掉，避免出现两个容器
  disposePrintSession(doc);

  const style = doc.createElement("style");
  style.id = PRINT_STYLE_ID;
  style.media = "print";
  style.textContent = buildPrintCss(pickLightTokenDeclarations(doc));
  doc.head.append(style);

  const root = doc.createElement("div");
  root.id = PRINT_ROOT_ID;
  root.style.display = "none";

  const article = doc.createElement("article");
  article.className = "markdown-body";
  article.innerHTML = bodyHtml;
  root.append(article);
  doc.body.append(root);

  // 相对路径图片转 asset:// —— 必须在 innerHTML 之后。
  // 不传 baseDir 时保留 data-md-src，交给调用方处置（打印只在有文档路径时才走这条）。
  if (options.baseDir) resolveAssetImages(article, options.baseDir);

  return {
    root,
    article,
    dispose: () => disposePrintSession(doc),
  };
}

// ------------------------------------------------------------ 编排

export type PrintOutcome =
  /** 已调起打印，用户是否真的打由系统对话框决定，这里无从得知 */
  | { status: "printed" }
  /** 没内容可印 */
  | { status: "nothing" };

/**
 * 一条龙：渲染 → 挂载 → 逼一次布局 → window.print() → 清理。
 *
 * 失败一律抛错，由调用方（工具栏）转成用户可见的提示 —— 打印这条路不允许静默失败，
 * 否则用户会以为"点了没反应"。
 *
 * ⚠ 关于 Ctrl+P：本机 Tauri（2.12）没有暴露 WebView2 的
 * `AreBrowserAcceleratorKeysEnabled`，wry 默认是开的，**系统可能自己吃掉 Ctrl+P**
 * 而去打印原始界面。所以工具栏按钮才是保证路径，Ctrl+P 只是最佳努力别名。
 */
export async function printDocument(params: {
  markdown: string;
  /** 文档所在目录，用于把相对路径图片换成 asset:// */
  baseDir?: string;
  doc?: Document;
}): Promise<PrintOutcome> {
  if (!params.markdown.trim()) return { status: "nothing" };

  const doc = params.doc ?? document;
  const bodyHtml = await renderSanitizedHtml(params.markdown);
  const session = mountPrintRoot(bodyHtml, { baseDir: params.baseDir, doc });

  try {
    if (typeof window.print !== "function") {
      throw new Error("当前环境不支持 window.print()");
    }
    // 读一次尺寸，逼浏览器立刻完成样式计算与布局。
    // 打印快照取的是"此刻已排好的版面"，不逼这一下有可能拿到一页空白。
    void doc.body.offsetHeight;
    window.print();
    return { status: "printed" };
  } finally {
    session.dispose();
  }
}
