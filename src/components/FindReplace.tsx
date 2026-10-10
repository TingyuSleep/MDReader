/**
 * 查找 / 替换面板。
 *
 * 为什么自己写匹配而不是用 CodeMirror 自带的 search 扩展：
 *   1. 自带面板是英文的（Find / Replace / regexp…），跟本项目的中文界面不搭，
 *      而且 `createPanel` 只能塞原生 DOM，跟 React 状态同步很别扭。
 *   2. 自带扩展不暴露「第几个 / 共几个」，做不出「3 / 17」这种计数器。
 *   3. 需求只有「普通文本 + 正则」两档，匹配逻辑本身很短，自己写反而更可控。
 *   代价是要自己处理零宽匹配、全词边界、上限保护 —— 下面都写了。
 *
 * 匹配结果每次都用 store 里的**实时 content** 重算（不是防抖后的副本），
 * 否则刚替换完就会选到错位的范围。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { ChevronDown, ChevronUp, Replace, ReplaceAll, X } from "lucide-react";

import { getActiveEditorView } from "@/components/Editor";
import { cn } from "@/lib/utils";

/** 单次扫描的匹配上限。防止 1MB 文档 + `a*` 这类模式把主线程锁死。 */
const MATCH_LIMIT = 5000;

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

interface MatchRange {
  from: number;
  to: number;
}

interface MatchScan {
  ranges: MatchRange[];
  /** 命中数被 MATCH_LIMIT 截断 */
  truncated: boolean;
  /** 正则语法错误等。非 null 时 ranges 一定为空。 */
  error: string | null;
}

const EMPTY_SCAN: MatchScan = { ranges: [], truncated: false, error: null };

/** 全词边界判定的「词字符」。刻意不含中日韩 —— 中文没有空格分词，全词匹配对它没意义。 */
const WORD_CHAR = /[0-9A-Za-z_]/;

function escapeLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 带边界的匹配，避免用 lookbehind（不同引擎支持度不一致） */
function isWholeWordAt(text: string, from: number, to: number): boolean {
  const before = from > 0 ? text[from - 1] : "";
  const after = to < text.length ? text[to] : "";
  if (before && WORD_CHAR.test(before)) return false;
  if (after && WORD_CHAR.test(after)) return false;
  return true;
}

/**
 * 扫描全部匹配。纯函数 —— 单独导出以便验收脚本直接打靶，不用去模拟输入框。
 */
export function collectMatches(text: string, find: string, options: SearchOptions): MatchScan {
  if (!find) return EMPTY_SCAN;

  // 普通文本模式补上 u 标志，保证中文与 emoji 按码点处理；
  // 正则模式不加 u —— 用户写了 `\{` 这类非 u 合法语法时不该被我们判为错误。
  const source = options.regex ? find : escapeLiteral(find);
  const flags = options.caseSensitive ? (options.regex ? "g" : "gu") : options.regex ? "gi" : "giu";

  let pattern: RegExp;
  try {
    pattern = new RegExp(source, flags);
  } catch (err) {
    return {
      ranges: [],
      truncated: false,
      error: `正则表达式无效：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ranges: MatchRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;

    if (match[0].length === 0) {
      // 零宽匹配（`a*`、`^`）永远不会推进 lastIndex，不手动推就是死循环
      pattern.lastIndex += 1;
      continue;
    }

    if (options.wholeWord && !isWholeWordAt(text, from, to)) continue;

    ranges.push({ from, to });
    if (ranges.length >= MATCH_LIMIT) {
      return { ranges, truncated: true, error: null };
    }
  }

  return { ranges, truncated: false, error: null };
}

/**
 * 计算单个匹配的替换文本。
 *
 * 普通文本模式**原样插入** —— `$1` 不当分组引用，否则用户想把内容换成字面量
 * `$1` 反而做不到。正则模式才展开 `$1` / `$&` 这些：让 String.replace 拿着
 * 原 pattern（去掉 g）在匹配片段上再跑一次，展开规则就完全一致了。
 *
 * 已知局限：pattern 带 `^` / `$` 锚点时，片段级重跑会错。这种情况罕见，
 * 退化成原样插入比抛错友好。
 */
function expandReplacement(
  matchedText: string,
  replacement: string,
  patternSource: string,
  options: SearchOptions,
): string {
  if (!options.regex) return replacement;
  try {
    return matchedText.replace(
      new RegExp(patternSource, options.caseSensitive ? "" : "i"),
      replacement,
    );
  } catch {
    return replacement;
  }
}

// ------------------------------------------------------------ 组件

interface FindReplaceProps {
  /** 当前文档全文（来自 store） */
  content: string;
  onClose: () => void;
  /** 替换发生在编辑器视图缺失时，要把原因说清楚 */
  onNotice: (message: string) => void;
}

export function FindReplace({ content, onClose, onNotice }: FindReplaceProps) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [cursor, setCursor] = useState(0);

  const findInputRef = useRef<HTMLInputElement | null>(null);

  const options: SearchOptions = { regex, caseSensitive, wholeWord };
  // options 每次渲染都是新对象，所以把字段逐个列进依赖，而不是依赖对象本身 ——
  // 依赖对象会让 useMemo 每次都失效，等于没做缓存。
  const scan = useMemo(
    () => collectMatches(content, find, options),
    // 字段必须和上面三个 useState 同步增删
    [content, find, regex, caseSensitive, wholeWord],
  );

  // 在 effect 里读 scan 时拿最新值：把 scan 塞进 effect 依赖会让「编辑区每敲一个字」
  // 都触发一次跳转，把光标从编辑位置拽回第一个匹配。
  const scanRef = useRef(scan);
  scanRef.current = scan;

  function selectRange(from: number, to: number, behavior?: { focus?: boolean }): boolean {
    const view = getActiveEditorView();
    if (!view) {
      onNotice("当前布局没有编辑区（仅预览模式），查找无法定位到文本");
      return false;
    }
    // dispatch 不会抢焦点。只有用户主动点「下一个」时才把焦点还给编辑区，
    // 否则在查找框里打字打一半焦点就跑了。
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    if (behavior?.focus !== false) view.focus();
    return true;
  }

  // 查询条件一变就回到第一处并选中 —— 「输入即看到第一个结果」。
  // ⚠ 依赖里刻意不含 content / scan：含了的话，在编辑区每敲一个字都会被拽回第一处匹配。
  // 这里没有 lint 规则兜底，改依赖时务必留意。
  useEffect(() => {
    setCursor(0);
    const first = scanRef.current.ranges[0];
    if (first) selectRange(first.from, first.to, { focus: false });
  }, [find, regex, caseSensitive, wholeWord]);

  // 打开面板即聚焦输入框（面板是被条件渲染出来的，挂载即需要焦点）。
  // 必须排在上面那个 effect 之后，否则首屏焦点会被 selectRange 的 focus:false 打乱。
  useEffect(() => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  function step(delta: number): void {
    const total = scan.ranges.length;
    if (total === 0) return;
    const next = (cursor + delta + total) % total;
    const range = scan.ranges[next];
    if (!range) return;
    if (selectRange(range.from, range.to)) setCursor(next);
  }

  function replaceCurrent(): void {
    const range = scan.ranges[cursor];
    const view = getActiveEditorView();
    if (!view) {
      onNotice("当前布局没有编辑区（仅预览模式），无法执行替换");
      return;
    }
    if (!range) return;

    const insert = expandReplacement(
      content.slice(range.from, range.to),
      replace,
      regex ? find : escapeLiteral(find),
      options,
    );

    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
    });
    view.focus();
  }

  function replaceEvery(): void {
    const view = getActiveEditorView();
    if (!view) {
      onNotice("当前布局没有编辑区（仅预览模式），无法执行替换");
      return;
    }
    if (scan.ranges.length === 0) return;

    const patternSource = regex ? find : escapeLiteral(find);
    // 一次性把所有改动塞进同一个事务 —— 这样 Ctrl+Z 一下就能整体撤销
    view.dispatch({
      changes: scan.ranges.map((range) => ({
        from: range.from,
        to: range.to,
        insert: expandReplacement(content.slice(range.from, range.to), replace, patternSource, options),
      })),
    });
    view.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  }

  const total = scan.ranges.length;
  const status = scan.error
    ? scan.error
    : !find
      ? "输入要查找的内容"
      : total === 0
        ? "没有匹配"
        : `${cursor + 1} / ${total}${scan.truncated ? "+" : ""}`;
  const statusTone = scan.error ? "text-destructive" : total === 0 || !find ? "text-muted-foreground" : "text-foreground";

  return (
    <div
      role="dialog"
      aria-label="查找与替换"
      className={cn(
        "absolute right-3 top-3 z-20 w-[min(30rem,calc(100%-1.5rem))] rounded-lg",
        "border border-border bg-popover p-2 text-popover-foreground shadow-lg",
      )}
    >
      {/* ---- 查找行 ---- */}
      <div className="flex items-center gap-1">
        <input
          ref={findInputRef}
          value={find}
          onChange={(event) => setFind(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="查找"
          aria-label="查找"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        />

        <span className={cn("min-w-[4.5rem] shrink-0 px-1 text-center text-xs", statusTone)} title={status}>
          {status}
        </span>

        <button
          type="button"
          title="上一个 (Shift+Enter)"
          aria-label="上一个"
          onClick={() => step(-1)}
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          type="button"
          title="下一个 (Enter)"
          aria-label="下一个"
          onClick={() => step(1)}
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <ChevronDown className="size-4" />
        </button>
        <button
          type="button"
          title="关闭 (Esc)"
          aria-label="关闭查找"
          onClick={onClose}
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* ---- 替换行 ---- */}
      {showReplace && (
        <div className="mt-1 flex items-center gap-1">
          <input
            value={replace}
            onChange={(event) => setReplace(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={regex ? "替换为（支持 $1 / $&）" : "替换为"}
            aria-label="替换为"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          <button
            type="button"
            title="替换当前"
            onClick={replaceCurrent}
            disabled={total === 0}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <Replace className="size-3.5" />
            替换
          </button>
          <button
            type="button"
            title="替换全部（可一次 Ctrl+Z 撤销）"
            onClick={replaceEvery}
            disabled={total === 0}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <ReplaceAll className="size-3.5" />
            全部
          </button>
        </div>
      )}

      {/* ---- 选项 ---- */}
      <div className="mt-1 flex items-center gap-1">
        <ToggleChip active={caseSensitive} label="区分大小写" text="Aa" onClick={() => setCaseSensitive((v) => !v)} />
        <ToggleChip active={wholeWord} label="全词匹配（仅对英文有效）" text="ab" onClick={() => setWholeWord((v) => !v)} />
        <ToggleChip active={regex} label="正则表达式" text=".*" onClick={() => setRegex((v) => !v)} />
        <button
          type="button"
          onClick={() => setShowReplace((v) => !v)}
          className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {showReplace ? "收起替换" : "显示替换"}
        </button>
      </div>

      {scan.truncated && (
        <p className="mt-1 text-xs text-muted-foreground">
          匹配数超过 {MATCH_LIMIT} 条上限，只展示并操作前 {MATCH_LIMIT} 条。
        </p>
      )}
    </div>
  );
}

function ToggleChip({
  active,
  label,
  text,
  onClick,
}: {
  active: boolean;
  label: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 min-w-7 rounded px-1.5 font-mono text-xs transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {text}
    </button>
  );
}
