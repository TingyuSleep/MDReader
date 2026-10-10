/**
 * 底部状态栏。
 *
 * 两条边界，决定了它长成现在这样：
 *
 * 1. **光标位置不进 zustand。**
 *    光标每敲一个键、每动一次选区都在变，放进 store 会让**所有**订阅者
 *    （Toolbar、App）跟着重渲，而它们一个都不关心光标。所以走
 *    `lib/cursor.ts` 那对极小的订阅，配合 `useSyncExternalStore`，
 *    把重渲范围锁死在本组件内部。文档内容/编码这类低频状态才读 store。
 *
 * 2. **度量算在渲染里，但用 `useDeferredValue` 隔离。**
 *    字数统计要扫全文，一篇 256 KB 的文档每次按键都重算是纯浪费。
 *    `useDeferredValue` 让 React 优先保证输入框跟手，状态栏稍后追上 ——
 *    比手写防抖少一个定时器，也不会出现"停手了数字还慢半拍"的观感。
 *
 * 度量规则本身在 `lib/status-metrics.ts`，本组件只负责取值与排版。
 */
import { useDeferredValue, useMemo, useSyncExternalStore } from "react";

import { getCursorPos, subscribeCursor } from "@/lib/cursor";
import { formatCursor, measureDocument } from "@/lib/status-metrics";
import { useEditor, type ViewMode } from "@/store/editor";
import type { EolStyle, TextEncoding } from "@/types";

const ENCODING_LABEL: Record<TextEncoding, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 BOM",
};

const EOL_LABEL: Record<EolStyle, string> = {
  lf: "LF",
  crlf: "CRLF",
  cr: "CR",
};

const VIEW_LABEL: Record<ViewMode, string> = {
  live: "实时预览",
  source: "源码",
};

/** 分隔点。比竖线轻，也不会在小字号下被当成字母 `l`。 */
function Dot() {
  return (
    <span aria-hidden className="text-border">
      ·
    </span>
  );
}

export function StatusBar() {
  const content = useEditor((state) => state.content);
  const path = useEditor((state) => state.path);
  const encoding = useEditor((state) => state.encoding);
  const eol = useEditor((state) => state.eol);
  const viewMode = useEditor((state) => state.viewMode);

  /*
    光标来自 lib/cursor.ts 的外部订阅，数据源是 CodeMirror 的 updateListener。
    再强调一次为什么不读 DOM 的 `selectionchange`：那只在有焦点时触发，
    程序性改选区（查找替换选中匹配项）收不到事件，状态栏会静默停在上一次的位置。
  */
  const cursor = useSyncExternalStore(subscribeCursor, getCursorPos);

  const deferredContent = useDeferredValue(content);
  const metrics = useMemo(() => measureDocument(deferredContent), [deferredContent]);

  const empty = path === null && content.length === 0;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-toolbar-bg px-3 text-xs text-muted-foreground tabular-nums select-none">
      {empty ? (
        <span>就绪</span>
      ) : (
        <>
          <span title={`词数：中日韩逐字，西文按词。字符数（含空格）${metrics.chars}`}>
            字数 {metrics.words}
          </span>
          <Dot />
          <span title={`字符 ${metrics.chars}，不含空格 ${metrics.charsNoSpace}`}>
            字符 {metrics.chars}
          </span>
          <Dot />
          <span title="行数">行 {metrics.lines}</span>
          {cursor && cursor.selected > 0 && (
            <>
              <Dot />
              <span title="已选中的字符数">已选 {cursor.selected}</span>
            </>
          )}
        </>
      )}

      <span className="flex-1" />

      <span title="文件编码">{encoding ? ENCODING_LABEL[encoding] : "—"}</span>
      <Dot />
      <span title="换行符">{eol ? EOL_LABEL[eol] : "—"}</span>
      <Dot />
      <span title="当前视图模式">{VIEW_LABEL[viewMode]}</span>
      <Dot />
      <span title="光标位置">
        {cursor ? formatCursor(cursor.line, cursor.col) : "行 — 列 —"}
      </span>
    </footer>
  );
}
