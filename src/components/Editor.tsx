/**
 * CodeMirror 6 编辑区。
 *
 * 四个容易踩的点：
 *   1. **视图只在切换视图模式时重建**。文档切换走 dispatch 整体替换 doc，不重建 EditorView，
 *      否则撤销历史、光标位置全丢。
 *   2. **程序性替换文档必须打注解**，否则 updateListener 会把它当成用户输入，
 *      反手把内容又 setContent 一遍。
 *   3. **配色全部走 CSS 变量**，不写死颜色也不用 themeType 明暗两套。
 *      这样主题切换只要 `.dark` 一挂，编辑区自动跟着变，不需要任何 JS 参与。
 *   4. **实时预览扩展不能动态增删**。CodeMirror 的扩展列表是创建 EditorState 时确定的，
 *      所以「实时预览 ↔ 源码」切换靠重建 EditorView 实现，滚动位置得手动接回来。
 */
import { useEffect, useRef } from "react";

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { Annotation, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { livePreview } from "@/lib/live-preview";
import { setCursorPos } from "@/lib/cursor";
import { useEditor } from "@/store/editor";

/** 标记「这次事务是程序性替换」，不是用户输入 */
const ExternalDocChange = Annotation.define<boolean>();

/**
 * 把当前光标位置推到共享槽（状态栏消费）。
 *
 * 放在这里而不是让状态栏去读 DOM：**每次选区变化都必然产生一个事务**，
 * 走 updateListener 才能覆盖程序性改选区（例如查找替换选中匹配项），
 * 而那正是 DOM `selectionchange` 收不到的情形。
 */
function reportCursor(view: EditorView): void {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  setCursorPos({
    line: line.number,
    // 列从 1 起，和行号栏口径一致；`sel.head - line.from` 是 0 基的
    col: sel.head - line.from + 1,
    selected: sel.to - sel.from,
  });
}

/**
 * 请求打开查找面板的事件名。
 *
 * 编辑区的 keymap 只能绑同步回调，而面板开关状态在 App 里，两者没有共用的
 * 上下文。用一次 CustomEvent 做解耦，比为此引入 Context 或把 EditorView
 * 塞进全局状态都要轻。
 */
export const TOGGLE_FIND_EVENT = "md-reader:toggle-find";

// ------------------------------------------------------------ 活动视图注册表

/**
 * 当前挂载的 EditorView。
 *
 * 查找替换需要直接派发事务（选中匹配、替换文本），只能拿到 view 本体。
 * 刻意**不放进 zustand**：EditorView 是可变对象、不可序列化，
 * 放进 state 会让每次 set 都触发无意义比较，也容易让人误以为它是纯数据。
 * 同一时刻只会有一个 Editor 实例，所以单槽足够。
 */
let activeView: EditorView | null = null;

/** 取当前编辑器视图；未挂载时返回 null（调用方必须自己判空，不要兜底造假数据） */
export function getActiveEditorView(): EditorView | null {
  return activeView;
}

/** 暴露给验收脚本：等 Editor 挂载完成 */
export function hasActiveEditorView(): boolean {
  return activeView !== null;
}

// ------------------------------------------------------------ 语法配色

/**
 * Markdown 语法高亮。
 *
 * 颜色全部引用 CSS 变量（定义在 src/index.css 的 :root / .dark 里），
 * 所以明暗主题切换不需要重新创建编辑区，也不需要 themeType 那套机制。
 *
 * 实时预览模式下这套高亮还有第二个作用：**标记被藏掉之后，剩下的内容靠它撑住样式**。
 * 比如 `*斜体*` 藏掉两个 `*`，剩下的文字是不是斜体，全靠这里的 `t.emphasis`。
 * 所以改这里的规则会同时影响源码模式和实时预览，别当成纯配色看待。
 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--cm-heading)", fontWeight: "650" },
  { tag: t.heading1, color: "var(--cm-heading)", fontWeight: "700" },
  { tag: t.strong, color: "var(--cm-strong)", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--cm-link)", textDecoration: "underline" },
  { tag: t.url, color: "var(--cm-url)" },
  { tag: t.monospace, color: "var(--cm-code)" },
  { tag: t.quote, color: "var(--cm-quote)", fontStyle: "italic" },
  { tag: t.list, color: "var(--cm-markup)" },
  { tag: t.contentSeparator, color: "var(--cm-sep)" },
  // Markdown 的 # * ` > 这类标记符本身
  { tag: t.processingInstruction, color: "var(--cm-markup)" },
  { tag: t.labelName, color: "var(--cm-label)" },
  { tag: t.escape, color: "var(--cm-markup)" },
  // 编辑区里出现代码块时，用得上这几个
  { tag: t.comment, color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--cm-keyword)" },
  { tag: t.string, color: "var(--cm-string)" },
  { tag: t.number, color: "var(--cm-number)" },
  { tag: t.bool, color: "var(--cm-bool)" },
  { tag: t.typeName, color: "var(--cm-type)" },
  { tag: t.function(t.variableName), color: "var(--cm-func)" },
]);

// ------------------------------------------------------------ 外观

const MONO_STACK =
  '"Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei Mono", monospace';

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--editor-bg)",
    color: "var(--foreground)",
    fontSize: "14px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: MONO_STACK,
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": { padding: "14px 0", caretColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "var(--accent)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--accent)",
    color: "var(--foreground)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--muted-foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  /*
    选区。

    这里有两个坑，都不是「把颜色改深一点」能解决的：

    1) 颜色改对了照样看不见。

       CM 的 `.cm-selectionLayer` 是 `z-index: -2`，而 `.cm-content`（以及它里面的
       `.cm-line`）是**普通流内元素** —— 流内内容画在负 z-index 之后，
       所以任何盖在选区上的不透明背景都能把它整个吃掉。

       最常见的牺牲品就是 `.cm-activeLine`：光标所在那一行永远看不到选区，
       而那一行恰恰是拖选时一直盯着的那一行，症状就是「根本不知道选中了哪些字」。
       代码块底色、表格表头底色同理。

       所以把选区层抬到正文之上（1），只留在光标层（150，cm-layer-above）下面。
       这一下解决全部遮挡，不用逐个去给装饰层加透明度 —— 也挡得住以后新加的装饰。

       ⚠ 这里必须 `!important`：CM 是把 z-index 写成**行内样式**的
       （`<div class="cm-layer cm-selectionLayer" style="z-index: -2">`），
       行内样式压过任何选择器，写得再深也没用。实测过「规则明明写了却毫无变化」，
       最后靠 `getAttribute("style")` 才看出来。这不是偷懒，是唯一能压过行内样式的手段。

    2) 抬上来之后颜色必须带 alpha，否则会把文字整块糊掉。

       这正是浏览器原生 `::selection` 的做法：高亮盖在字上，字从高亮里透出来。
       两个令牌 `--cm-selection-bg` / `--cm-selection-bg-dim` 都带透明度。

    选择器深度照旧要写足 —— drawSelection 自带的规则是 0-5-0，
    写浅了连颜色都抢不到（只写 `.cm-selectionBackground` 时实测一直用它的默认淡紫）。
    聚焦 / 未聚焦各一条：点工具栏时编辑区失焦，不该让选区直接消失。
  */
  "& .cm-selectionLayer": { zIndex: "1 !important" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--cm-selection-bg)",
  },
  "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--cm-selection-bg-dim)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--accent)",
    outline: "1px solid var(--ring)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--accent)" },
});

// ------------------------------------------------------------ 组件

export function Editor() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 跨视图重建保留的滚动位置 */
  const pendingScrollRef = useRef(0);

  const documentId = useEditor((state) => state.documentId);
  const isEmpty = useEditor((state) => state.content.length === 0);
  const viewMode = useEditor((state) => state.viewMode);
  const isLive = viewMode === "live";

  // ---- 创建视图。切视图模式会走一遍销毁 + 重建
  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: useEditor.getState().content,
        extensions: [
          // 行号与折叠标记只在源码模式下出现。实时预览里正文是居中单栏，
          // 左边再挂一条 gutter 会把它挤偏；Typora 也没有行号。
          ...(isLive ? [] : [lineNumbers(), highlightActiveLineGutter(), foldGutter()]),

          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(markdownHighlight),
          markdown({ base: markdownLanguage }),

          // 视图模式差异全部收在这两行里。`cm-live-preview` / `cm-source-mode`
          // 挂在 .cm-editor 上，样式在 src/index.css 里按这个 class 分叉。
          ...(isLive
            ? [
                EditorView.editorAttributes.of({ class: "cm-live-preview" }),
                livePreview({ getDocumentPath: () => useEditor.getState().path }),
              ]
            : [EditorView.editorAttributes.of({ class: "cm-source-mode" })]),

          EditorView.lineWrapping,
          EditorState.tabSize.of(4),
          editorTheme,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                void useEditor.getState().save();
                return true;
              },
            },
            {
              // 接管 Ctrl+F：CodeMirror 自带的 searchKeymap 会打开它那把英文面板，
              // 样式和本项目不搭。这里改发事件，由 App 打开自己的查找面板。
              // 注意顺序必须在 defaultKeymap 之前，键位冲突时先注册者优先。
              key: "Mod-f",
              preventDefault: true,
              run: () => {
                window.dispatchEvent(new CustomEvent(TOGGLE_FIND_EVENT));
                return true;
              },
            },
            {
              // Ctrl+/ 切换源码模式。Typora 用同一组键位，从那边过来的人不用重学。
              key: "Mod-/",
              preventDefault: true,
              run: () => {
                const state = useEditor.getState();
                state.setViewMode(state.viewMode === "source" ? "live" : "source");
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            // 光标要先于 docChanged 的早退上报：只挪光标不改内容时
            // 同样要更新状态栏，否则它会一直停在上一次的位置。
            reportCursor(update.view);

            if (!update.docChanged) return;
            // 程序性替换不算用户输入，否则会把刚打开的内容再喂回去
            if (update.transactions.some((tr) => tr.annotation(ExternalDocChange))) return;
            useEditor.getState().setContent(update.state.doc.toString());
          }),
        ],
      }),
      parent,
    });

    view.scrollDOM.scrollTop = pendingScrollRef.current;

    viewRef.current = view;
    activeView = view;
    // 创建视图不产生事务，updateListener 不会被调用，得主动报一次初始位置
    reportCursor(view);

    return () => {
      // 先记下滚动位置再销毁 —— 切模式回来要停在原处，不能弹回开头
      pendingScrollRef.current = view.scrollDOM.scrollTop;
      view.destroy();
      viewRef.current = null;
      activeView = null;
      // 挡住"视图没了但状态栏还显示上一次光标"的假象
      setCursorPos(null);
    };
  }, [isLive]);

  // ---- 文档切换：整体替换
  useEffect(() => {
    const view = viewRef.current;
    if (!view || documentId === 0) return;

    const next = useEditor.getState().content;
    if (view.state.doc.toString() === next) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: 0 },
      scrollIntoView: true,
      annotations: ExternalDocChange.of(true),
    });
    view.focus();
  }, [documentId]);

  return (
    <div className="relative h-full min-w-0 overflow-hidden">
      <div ref={containerRef} className="h-full" />
      {isEmpty && (
        <div className="pointer-events-none absolute inset-x-0 top-4 text-center text-sm text-[var(--muted-foreground)]">
          还没有内容 —— 拖一个 .md 文件进来，或从工具栏「打开」开始
        </div>
      )}
    </div>
  );
}
