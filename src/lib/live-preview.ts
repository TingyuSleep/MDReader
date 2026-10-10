/**
 * Live Preview —— 单栏所见即所得编辑层。
 *
 * 核心思路只有一句话：**用 Decoration 把语法标记藏起来**，让编辑区自己长得像渲染结果。
 * 不是把 Markdown 转成 HTML（那样就没法编辑了），而是让源代码「看起来」已经是结果 ——
 * 光标移到哪一块，那一块的标记就重新显形，随时可改。Typora / Obsidian 实时预览都是这个路子。
 *
 * 三类装饰，各管一摊：
 *   - `Decoration.replace`  藏掉 `**` `#` `[` `](url)` 这类标记；或换成真的控件（复选框 / 图片 / 分隔线）
 *   - `Decoration.mark`     给行内内容挂 class（行内代码底色、链接着色）
 *   - `Decoration.line`     给整行挂 class（标题字号、引用左边框、代码块底色）
 *
 * ## 标记「什么时候该显形」——两条粒度不同的规则
 *
 *   - **块级标记**（`#` `>` `-` `[ ]`）：按**行**豁免 —— 光标落在这一行就整行显形。
 *     它们决定行首缩进，藏起来容易让人找不着北，整行显示更符合直觉。
 *   - **行内标记**（`**` `` ` `` `[..](..)` `~~`）：按**元素**豁免 —— 光标落在该元素范围内才显形。
 *     否则写长段落时，中间那些 `**` 会一直晃着，很吵。
 *
 * ## 刻意不做的事
 *
 *   - **不隐藏原始 HTML 标签**。lezer 会把 HTML 拆成 80 多种节点，逐个藏既不现实也没必要 ——
 *     段落里混 HTML 本来就少见，保持源码显示反而是最诚实的做法。
 *   - **不隐藏围栏代码块的 ``` 和表格的 `|`**。这两样藏了以后结构反而更难辨认
 *     （表格脱掉 `|` 就是一串认不出列宽的裸文本）。只给它们加行装饰做视觉分区。
 *
 * ## 节点名依据
 *
 * 下面所有节点名都来自 `@lezer/markdown` 1.8.0 配 GFM 的实测输出
 * （探针脚本：`dev/dump-syntax-tree.mjs`），不是照文档猜的。
 * 注意两个容易踩的坑：`EmphasisMark` 同时用于 `*` 和 `**`；
 * `CodeMark` 同时用于行内代码和围栏代码 —— 都得靠 parent 名字区分。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range, SelectionRange, Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";

import { dirName, toAssetUrl } from "./fs";
import { resolveRelativePath } from "./markdown-path";

// ------------------------------------------------------------ 固定装饰实例

/**
 * 藏掉一段标记。
 *
 * 用空 replace（而不是 mark 成透明）—— 标记字符不占宽度，`**粗体**` 剩下的 `粗体`
 * 才会像渲染结果那样紧贴前后文。用 opacity 的话缩进全是错的。
 */
const hideMark = Decoration.replace({});

/** 行内代码内容：加底色与等宽字体 */
const inlineCodeMark = Decoration.mark({ class: "cm-md-inline-code" });

/** 链接文本：着色 + 下划线 */
const linkMark = Decoration.mark({ class: "cm-md-link" });

/** 图片替代文字（地址解析不出来、退回源码显示时用） */
const imageAltMark = Decoration.mark({ class: "cm-md-image-alt" });

/** 无序列表项目符号 —— 把 `-` 换成一个点。宽度接近，切换时缩进不跳。 */
class BulletWidget extends WidgetType {
  // 无状态，全局共用一个实例，省掉每次重建装饰时的对象分配
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
  /** 点击落到标记上时让 CM 照常处理 —— 光标进入该行后标记就会显形，可以接着改 */
  ignoreEvent(): boolean {
    return false;
  }
}

const bulletWidget = new BulletWidget();

/** 水平分隔线 —— `---` 换成一条真的横线 */
class HorizontalRuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-hr";
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const hrWidget = new HorizontalRuleWidget();

/**
 * 任务列表复选框。
 *
 * 直接改文档内容（`[ ]` ↔ `[x]`）而不是维护一份独立状态 ——
 * 文件里存的就是 `[x]`，两者不该有两份真相。
 */
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** `[ ]` 在文档中的起始偏移。widget 可能被 CM 缓存复用，所以切换时按当前值写回。 */
    readonly pos: number,
  ) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-md-task";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为已完成");

    input.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 位置可能因为之前的编辑而失效，用当前文档长度兜一下底
      const to = this.pos + 3;
      if (to > view.state.doc.length) return;
      view.dispatch({
        changes: { from: this.pos, to, insert: this.checked ? "[ ]" : "[x]" },
      });
    });

    return input;
  }
}

/**
 * 图片预览。
 *
 * `eq` 必须实现 —— 否则每次重建装饰都会造一份新 DOM，图片跟着重新请求一遍，整页疯狂闪烁。
 * 只要 url 和 alt 没变就复用旧节点。
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** 文档里写的原始地址，加载失败时显示给用户看，否则无从排查 */
    readonly raw: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image";

    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.title = this.alt ? `${this.alt}\n${this.raw}` : this.raw;

    // 图片有固有尺寸，加载完高度才定下来。不主动要求重新测量的话，
    // 后面的内容会一直按「高度 0」排版，整个视口都是歪的。
    img.addEventListener("load", () => view.requestMeasure(), { once: true });
    img.addEventListener(
      "error",
      () => {
        wrap.classList.add("cm-md-image-broken");
        wrap.textContent = `图片无法加载：${this.raw}`;
        view.requestMeasure();
      },
      { once: true },
    );

    wrap.appendChild(img);
    return wrap;
  }

  /** 交给 CM 处理点击 —— 光标落到图片上，该行显形后就能直接改地址 */
  ignoreEvent(): boolean {
    return false;
  }
}

// ------------------------------------------------------------ 构建上下文

interface BuildContext {
  doc: Text;
  /** 收集到的替换 / 标记装饰，最后一次性交给 Decoration.set 排序 */
  ranges: Range<Decoration>[];
  /**
   * 行首位置 → 该行的 class 集合。
   *
   * 同一行可能被多个节点要求加样式（引用里的标题、列表里的引用），
   * 在这里合并成**一条** line 装饰。同位置挂多条 line 装饰会让 RangeSet 的
   * 排序断言很难成立，合并之后彻底没有这个隐患。
   */
  lineClasses: Map<number, Set<string>>;
  /** 光标所在的行号集合 —— 块级标记的豁免判据 */
  activeLines: Set<number>;
  /** 当前选区 —— 行内标记的豁免判据 */
  selections: readonly SelectionRange[];
  /** 当前文档所在目录的路径，用于解析相对图片地址 */
  docPath: string | null;
}

function addLineClass(ctx: BuildContext, lineFrom: number, className: string): void {
  let classes = ctx.lineClasses.get(lineFrom);
  if (!classes) {
    classes = new Set<string>();
    ctx.lineClasses.set(lineFrom, classes);
  }
  classes.add(className);
}

/** 藏掉 `[from, to)`。`to <= from` 直接忽略 —— 零宽 replace 在 CM6 里是个折叠点，不是我们想要的。 */
function pushReplace(ctx: BuildContext, from: number, to: number): void {
  if (to <= from) return;
  ctx.ranges.push(hideMark.range(from, to));
}

/** 光标（或选区端点）是否落在 `[from, to]` 内。行内标记的豁免判据。 */
function selectionTouches(ctx: BuildContext, from: number, to: number): boolean {
  for (const range of ctx.selections) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function collectActiveLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n += 1) lines.add(n);
  }
  return lines;
}

/** 跳过 `from` 之后的连续空白（空格 / 制表符），上限 `limit` */
function skipSpacesForward(doc: Text, from: number, limit: number): number {
  let pos = from;
  while (pos < limit) {
    const ch = doc.sliceString(pos, pos + 1);
    if (ch !== " " && ch !== "\t") break;
    pos += 1;
  }
  return pos;
}

/** 跳过 `from` 之前的连续空白，下限 `limit` */
function skipSpacesBackward(doc: Text, limit: number, from: number): number {
  let pos = from;
  while (pos > limit) {
    const ch = doc.sliceString(pos - 1, pos);
    if (ch !== " " && ch !== "\t") break;
    pos -= 1;
  }
  return pos;
}

/** 直接子节点列表。`SyntaxNode` 只给了 firstChild/nextSibling 链，这里拉平成数组方便遍历。 */
function directChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
  return out;
}

// ------------------------------------------------------------ 图片地址解析

/**
 * 文档里写的图片地址 → WebView 能真正加载的 URL。解析不出来返回 null，
 * 调用方据此退回「只隐藏标记、保留替代文字」的降级显示。
 *
 * 拒绝除 http(s) / data:image / file / asset 之外的一切协议 —— 尤其是 `javascript:`，
 * 这类地址会被直接塞进 `<img src>`，不能指望别处再拦一道。
 */
function resolveImageSrc(raw: string, docPath: string | null): string | null {
  // Markdown 允许用尖括号把带空格的地址括起来
  const src = raw.trim().replace(/^<|>$/g, "");
  if (!src) return null;

  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:image\//i.test(src)) return src;
  if (/^asset:/i.test(src)) return src;
  if (/^file:/i.test(src)) return src;
  // 剩下凡是带协议的（javascript: / vbscript: / 自定义协议）一律拒绝
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

  // 相对路径得知道文档在哪，没落盘的新文档没法解析
  if (!docPath) return null;

  try {
    return toAssetUrl(resolveRelativePath(dirName(docPath), src));
  } catch {
    // 非 Tauri 环境（浏览器里跑验收）没有 asset 协议，退回相对路径碰运气
    return src;
  }
}

/** 取 `![alt](url)` 里的 alt。按 LinkMark 切 —— 第 0 个是 `![`，第 1 个是 `]`。 */
function imageAltText(node: SyntaxNode, doc: Text): string {
  const marks = node.getChildren("LinkMark");
  if (marks.length < 2) return "";
  return doc.sliceString(marks[0].to, marks[1].from);
}

// ------------------------------------------------------------ 块级节点

const HEADING_LINE = [1, 2, 3, 4, 5, 6].map((level) => `cm-md-h${level}`);

/** `# 标题` —— 行装饰负责放大字号，`#` 本身交给 handleHeaderMark 藏 */
function handleAtxHeading(node: SyntaxNodeRef, ctx: BuildContext): void {
  const level = Number(node.name.slice("ATXHeading".length));
  if (!Number.isInteger(level) || level < 1 || level > 6) return;
  const line = ctx.doc.lineAt(node.from);
  addLineClass(ctx, line.from, HEADING_LINE[level - 1]);
}

/** `标题\n===` —— 下划线式标题。文字行只是加样式，`===` 由 handleHeaderMark 藏。 */
function handleSetextHeading(node: SyntaxNodeRef, ctx: BuildContext): void {
  const level = node.name === "SetextHeading1" ? 1 : 2;
  const line = ctx.doc.lineAt(node.from);
  addLineClass(ctx, line.from, HEADING_LINE[level - 1]);
}

/** `> 引用` —— 涉及的每一行都加左边框 */
function handleBlockquote(node: SyntaxNodeRef, ctx: BuildContext): void {
  const first = ctx.doc.lineAt(node.from).number;
  const last = ctx.doc.lineAt(node.to).number;
  for (let n = first; n <= last; n += 1) {
    addLineClass(ctx, ctx.doc.line(n).from, "cm-md-quote");
  }
}

/**
 * 围栏代码块。
 *
 * 整块加底色，首尾行额外圆角 —— 拼出一个「框」的观感。
 * 围栏行（```js / ```）和内容行不区分 class：靠 `-first` / `-last` 就能定位。
 */
function handleFencedCode(node: SyntaxNodeRef, ctx: BuildContext): boolean {
  const first = ctx.doc.lineAt(node.from).number;
  const last = ctx.doc.lineAt(node.to).number;

  for (let n = first; n <= last; n += 1) {
    const line = ctx.doc.line(n);
    const isFirst = n === first;
    const isLast = n === last;
    addLineClass(ctx, line.from, "cm-md-codeblock");
    if (isFirst && isLast) addLineClass(ctx, line.from, "cm-md-codeblock-single");
    else if (isFirst) addLineClass(ctx, line.from, "cm-md-codeblock-first");
    else if (isLast) addLineClass(ctx, line.from, "cm-md-codeblock-last");
  }

  // 围栏块内部不再有需要装饰的节点，省掉一次子树遍历
  return false;
}

/** 表格 —— 只做等宽字体分区，`|` 保留 */
function handleTable(node: SyntaxNodeRef, ctx: BuildContext): boolean {
  const first = ctx.doc.lineAt(node.from).number;
  const last = ctx.doc.lineAt(node.to).number;

  for (let n = first; n <= last; n += 1) {
    const line = ctx.doc.line(n);
    addLineClass(ctx, line.from, "cm-md-table");
    if (n === first) addLineClass(ctx, line.from, "cm-md-table-head");
  }

  /*
    `| --- | --- |` 这一行纯粹是给解析器看的，人眼只需要列对齐。
    不藏（藏了列宽就无从判断），但压暗缩小，让它退到背景里去。
  */
  const delimiter = node.node.getChild("TableDelimiter");
  if (delimiter) {
    addLineClass(ctx, ctx.doc.lineAt(delimiter.from).from, "cm-md-table-delim");
  }

  return false;
}

/** `---` —— 换成一条真横线。光标移到该行时显形，又能改成别的东西。 */
function handleHorizontalRule(node: SyntaxNodeRef, ctx: BuildContext): void {
  const line = ctx.doc.lineAt(node.from);
  if (ctx.activeLines.has(line.number)) return;
  ctx.ranges.push(
    Decoration.replace({ widget: hrWidget }).range(node.from, node.to),
  );
}

/**
 * `![alt](src)` —— 能解析出地址就换成真的图片。
 *
 * 豁免用**行**粒度而不是元素粒度：图片是个大块，光标从旁边经过就闪回源码的话太吵。
 */
function handleImage(node: SyntaxNodeRef, ctx: BuildContext): boolean | void {
  const parent = node.node.parent;
  // 链接里套图片（`[![a](b)](c)`）很少见，处理起来要额外绕开重叠，直接保持源码显示
  if (parent?.name === "Link") return false;

  const line = ctx.doc.lineAt(node.from);
  if (ctx.activeLines.has(line.number)) return false;

  const urlNode = node.node.getChild("URL");
  if (!urlNode) return;

  const raw = ctx.doc.sliceString(urlNode.from, urlNode.to);
  const src = resolveImageSrc(raw, ctx.docPath);

  if (src) {
    const alt = imageAltText(node.node, ctx.doc);
    ctx.ranges.push(
      Decoration.replace({ widget: new ImageWidget(src, alt, raw) }).range(node.from, node.to),
    );
    // 整个 `![...](...)` 已被替换，子树不用再看
    return false;
  }

  // 解析不出可加载地址（典型情况：文档还没落盘，相对路径无从解析）：
  // 退一步只淡化标记、突出替代文字，至少让人一眼看出这里是个图片
  for (const child of directChildren(node.node)) {
    if (child.name === "LinkMark" || child.name === "URL") continue;
    if (child.from < child.to) ctx.ranges.push(imageAltMark.range(child.from, child.to));
  }
}

// ------------------------------------------------------------ 块级行首标记

/**
 * `#`（ATX 前导/尾随）与 `===`（Setext 下划线）。
 *
 * 前导 `#` 要连后面的空白一起吃 —— 否则 `# 标题` 藏掉 `#` 之后还剩一个前导空格，
 * 标题会比正文缩进一格。尾随 `#`（`# 标题 ##`）同理吃前面的空白。
 */
function handleHeaderMark(node: SyntaxNodeRef, ctx: BuildContext): void {
  const parent = node.node.parent;
  if (!parent) return;

  const line = ctx.doc.lineAt(node.from);
  if (ctx.activeLines.has(line.number)) return;

  if (parent.name.startsWith("ATXHeading")) {
    if (node.from === parent.from) {
      const end = skipSpacesForward(ctx.doc, node.to, parent.to);
      pushReplace(ctx, node.from, end);
    } else {
      const start = skipSpacesBackward(ctx.doc, parent.from, node.from);
      pushReplace(ctx, start, node.to);
    }
    return;
  }

  if (parent.name === "SetextHeading1" || parent.name === "SetextHeading2") {
    pushReplace(ctx, node.from, node.to);
  }
}

/** `>` —— 连后面的空白一起藏 */
function handleQuoteMark(node: SyntaxNodeRef, ctx: BuildContext): void {
  const parent = node.node.parent;
  if (!parent || parent.name !== "Blockquote") return;

  const line = ctx.doc.lineAt(node.from);
  if (ctx.activeLines.has(line.number)) return;

  const end = skipSpacesForward(ctx.doc, node.to, line.to);
  pushReplace(ctx, node.from, end);
}

const BULLET_MARKS = new Set(["-", "*", "+"]);

/**
 * `-` `*` `+` 换成项目符号。
 *
 * 有序列表的 `1.` 不换 —— 它本身就是渲染结果的样子，换了反而丢失编号信息。
 */
function handleListMark(node: SyntaxNodeRef, ctx: BuildContext): void {
  const raw = ctx.doc.sliceString(node.from, node.to);
  if (!BULLET_MARKS.has(raw)) return;

  const line = ctx.doc.lineAt(node.from);
  if (ctx.activeLines.has(line.number)) return;

  ctx.ranges.push(
    Decoration.replace({ widget: bulletWidget }).range(node.from, node.to),
  );
}

const TASK_MARKER = /^\[[ xX]\]$/;

/** `[ ]` / `[x]` 换成能点的复选框 */
function handleTaskMarker(node: SyntaxNodeRef, ctx: BuildContext): void {
  const raw = ctx.doc.sliceString(node.from, node.to);
  // 万一 lezer 换了范围，宁可不换也不要错位替换
  if (!TASK_MARKER.test(raw)) return;

  const line = ctx.doc.lineAt(node.from);
  if (ctx.activeLines.has(line.number)) return;

  const checked = raw[1] !== " ";
  ctx.ranges.push(
    Decoration.replace({ widget: new TaskWidget(checked, node.from) }).range(node.from, node.to),
  );
}

// ------------------------------------------------------------ 行内节点

/** `\`code\`` —— 只加内容底色，两个反引号由 handleInlineMark 藏 */
function handleInlineCode(node: SyntaxNodeRef, ctx: BuildContext): void {
  const marks = node.node.getChildren("CodeMark");
  if (marks.length < 2) return;

  const from = marks[0].to;
  const to = marks[marks.length - 1].from;
  if (to > from) ctx.ranges.push(inlineCodeMark.range(from, to));
}

/** `[文本](地址)` —— 给文本部分着色，标记与地址交给 handleLinkPart 藏 */
function handleLink(node: SyntaxNodeRef, ctx: BuildContext): void {
  // 光标落在链接上时整段显形，这时不要再着色，免得和源码混在一起看不清
  if (selectionTouches(ctx, node.from, node.to)) return;

  /*
    按 LinkMark 切出文本段，而不是遍历子节点找「非标记」的那些。
    lezer 把行内文本存成**匿名节点**（`name` 是空串），
    靠名字白名单/黑名单去筛很容易连正文一起漏掉或误伤；
    按标记切则直接对应语法结构，`[` 之后到 `]` 之前就是链接文字。
  */
  const marks = node.node.getChildren("LinkMark");
  if (marks.length < 2) return;

  const from = marks[0].to;
  const to = marks[1].from;
  if (to > from) ctx.ranges.push(linkMark.range(from, to));
}

const INLINE_MARK_PARENTS = new Set(["Emphasis", "StrongEmphasis", "Strikethrough"]);

/**
 * `*` `**` `~~` `` ` ``。
 *
 * `EmphasisMark` 同时服务 `*` 和 `**`，`CodeMark` 同时服务行内代码和围栏代码 ——
 * 两处都必须靠 parent 名字区分，光看节点名会误伤。
 */
function handleInlineMark(node: SyntaxNodeRef, ctx: BuildContext): void {
  const parent = node.node.parent;
  if (!parent) return;

  if (node.name === "CodeMark") {
    // 围栏代码块的 ``` 不在处理范围内
    if (parent.name !== "InlineCode") return;
  } else if (!INLINE_MARK_PARENTS.has(parent.name)) {
    return;
  }

  if (selectionTouches(ctx, parent.from, parent.to)) return;
  pushReplace(ctx, node.from, node.to);
}

/** `[` `]` `(` `)` 与链接地址本体 —— 只在父元素不是链接/图片时不动（防御性） */
function handleLinkPart(node: SyntaxNodeRef, ctx: BuildContext): void {
  const parent = node.node.parent;
  if (!parent) return;
  if (parent.name !== "Link" && parent.name !== "Image") return;

  if (selectionTouches(ctx, parent.from, parent.to)) return;
  pushReplace(ctx, node.from, node.to);
}

// ------------------------------------------------------------ 分派

function enterNode(node: SyntaxNodeRef, ctx: BuildContext): boolean | void {
  const name = node.name;

  // ---- 块级 ----
  if (name.startsWith("ATXHeading")) return handleAtxHeading(node, ctx);
  if (name === "SetextHeading1" || name === "SetextHeading2") return handleSetextHeading(node, ctx);
  if (name === "Blockquote") return handleBlockquote(node, ctx);
  if (name === "FencedCode") return handleFencedCode(node, ctx);
  if (name === "Table") return handleTable(node, ctx);
  if (name === "HorizontalRule") return handleHorizontalRule(node, ctx);
  if (name === "Image") return handleImage(node, ctx);

  // ---- 块级行首标记 ----
  if (name === "HeaderMark") return handleHeaderMark(node, ctx);
  if (name === "QuoteMark") return handleQuoteMark(node, ctx);
  if (name === "ListMark") return handleListMark(node, ctx);
  if (name === "TaskMarker") return handleTaskMarker(node, ctx);

  // ---- 行内 ----
  if (name === "InlineCode") return handleInlineCode(node, ctx);
  if (name === "Link") return handleLink(node, ctx);
  if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") {
    return handleInlineMark(node, ctx);
  }
  if (name === "LinkMark" || name === "URL") return handleLinkPart(node, ctx);

  return undefined;
}

/**
 * 走一遍可见范围内的语法树，产出这一帧的全部装饰。
 *
 * 只遍历 `visibleRanges` 而不是整棵树：装饰只对视口内的行有意义，1MB 的文档
 * 每敲一个字都全树遍历是没必要的开销。行装饰落在视口外也不会被渲染。
 */
function buildDecorations(view: EditorView, getDocumentPath: () => string | null): DecorationSet {
  const state = view.state;
  const ctx: BuildContext = {
    doc: state.doc,
    ranges: [],
    lineClasses: new Map(),
    activeLines: collectActiveLines(state),
    selections: state.selection.ranges,
    docPath: getDocumentPath(),
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({ from, to, enter: (node) => enterNode(node, ctx) });
  }

  // 行装饰最后统一合成，每行一条
  for (const [lineFrom, classes] of ctx.lineClasses) {
    ctx.ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(lineFrom));
  }

  // sort = true：节点遍历出来的顺序天然是乱的（父先于子、行装饰又在最后补），
  // 让 Decoration.set 自己按 from / startSide 排好，比自己维护顺序可靠得多
  return Decoration.set(ctx.ranges, true);
}

// ------------------------------------------------------------ 对外接口

export interface LivePreviewOptions {
  /**
   * 取当前文档的绝对路径，用来解析相对图片地址。
   * 不传（或返回 null）时，相对路径的图片会退回「只显示替代文字」。
   */
  getDocumentPath?: () => string | null;
}

/**
 * Live Preview 扩展。
 *
 * 只在实时预览模式下挂载 —— 源码模式要的是完全原样的编辑区，
 * 一个字都不该被藏起来。
 */
export function livePreview(options: LivePreviewOptions = {}): Extension {
  const getDocumentPath = options.getDocumentPath ?? ((): string | null => null);

  /*
    鼠标按下到抬起之间为 true —— 用来在**拖动期间冻住装饰层**。

    ⚠ 这不是「记住用户在干嘛」，而是在修一个很隐蔽的坐标 bug：
    拖动时选区每移动一次都会重算豁免，被扫过的 `**加粗**` 会当场显形，
    那一行的字符数随之增加，**后面所有文字的横坐标整体右移**。
    而 CodeMirror 是拿鼠标坐标反算文档位置的 —— 布局一变，同一处鼠标位置
    就对应到了另一个字符，选区终点于是自己往回缩。

    实测（dev/probe-selection.mjs，真实鼠标事件）：在 `第二行有 **加粗** 和 *斜体* 混排。`
    这段里跨过 `**加粗**` 拖选，期望选中 11 个字符，实际只选到 8 个。
    段落里标记越密，偏得越多，用起来就是「拖选选不准 / 选不动」。

    冻住之后 DOM 全程一动不动，坐标就不会骗人；松手时再补一次重建，
    被选中的那一段照样会按规则显形。
  */
  let dragging = false;

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** 拖动期间被压下的重建请求，松手后补做 */
      private pending = false;
      private readonly editorView: EditorView;
      private readonly onPointerRelease: () => void;

      constructor(view: EditorView) {
        this.editorView = view;
        this.decorations = buildDecorations(view, getDocumentPath);

        this.onPointerRelease = (): void => {
          if (!dragging) return;
          dragging = false;
          // 补一次重建：把拖动期间欠下的那次做掉，让标记按最终选区重新显形
          this.pending = true;
          this.editorView.dispatch({});
        };

        /*
          挂在 window 上而不是编辑器元素上：拖到编辑器外面（选到工具栏、窗口外）
          再松手是很常见的动作，只监听编辑器内部会漏掉，dragging 就永远卡在 true。
          blur 是第二道保险 —— 拖到一半 Alt+Tab 切走时 mouseup 可能压根不来。
        */
        window.addEventListener("mouseup", this.onPointerRelease);
        window.addEventListener("blur", this.onPointerRelease);
      }

      update(update: ViewUpdate): void {
        // syntaxTree 是异步增量解析的：解析推进时 state 没变、doc 也没变，
        // 但树的引用换了。漏掉这个判断，首屏就永远是「标记还没藏起来」的样子。
        const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);

        const stale =
          this.pending ||
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged ||
          treeChanged;
        if (!stale) return;

        if (dragging) {
          // 拖动中：只记一笔账，绝不动 DOM
          this.pending = true;
          return;
        }

        this.pending = false;
        this.decorations = buildDecorations(update.view, getDocumentPath);
      }

      destroy(): void {
        window.removeEventListener("mouseup", this.onPointerRelease);
        window.removeEventListener("blur", this.onPointerRelease);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );

  /**
   * 记下「开始拖了」。
   *
   * 必须返回 false：返回 true 等于告诉 CodeMirror 这个事件已被处理，
   * 拖选就再也起不来了。
   */
  const markDragging = EditorView.domEventHandlers({
    mousedown: () => {
      dragging = true;
      return false;
    },
  });

  return [plugin, markDragging];
}
