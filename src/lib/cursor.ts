/**
 * 光标位置的共享槽。
 *
 * 为什么单独开一个模块、而不是塞进 zustand：
 *   光标每敲一个键、每动一次选区都在变。放进 store 会让**所有**订阅者
 *   （Toolbar、App）跟着重渲，而它们一个都不关心光标。这里用一对极小的
 *   订阅/退订函数，配合 `useSyncExternalStore`，把重渲范围锁死在状态栏内部。
 *
 * 为什么数据源必须是 CodeMirror 的 `updateListener`、而不是 DOM 的 `selectionchange`：
 *   后者只在**编辑区有焦点**时才触发。而「查找替换选中匹配项」这类
 *   **程序性**改选区不会给它任何事件 —— 状态栏就会一直停在上一次的位置，
 *   不报错、也不闪，纯静默错误。实测过：`view.dispatch({selection})` 之后
 *   光标位置纹丝不动，就是这个原因。
 *   CodeMirror 的每次选区变化都必然产生一个事务，走 updateListener 才是完备的。
 */
export interface CursorPos {
  /** 1 基行号 */
  line: number;
  /** 1 基列号 */
  col: number;
  /** 选中字符数；0 表示只有光标没有选区 */
  selected: number;
}

let current: CursorPos | null = null;
const listeners = new Set<() => void>();

/**
 * 写入光标位置。
 *
 * 值没变时**直接返回，不通知订阅者**。这不是优化，是 `useSyncExternalStore` 的硬要求：
 * 它拿 `getSnapshot()` 的返回值做 `Object.is` 比较，如果每次都给新对象就会判定
 * "外部状态变了" → 重渲 → 再读 → 又新对象，无限循环并抛
 * "getSnapshot should be cached"。所以这里必须保证「没变就返回同一个引用」。
 */
export function setCursorPos(next: CursorPos | null): void {
  const prev = current;
  if (prev === next) return;
  if (
    prev !== null &&
    next !== null &&
    prev.line === next.line &&
    prev.col === next.col &&
    prev.selected === next.selected
  ) {
    return;
  }

  current = next;
  for (const listener of listeners) listener();
}

export function getCursorPos(): CursorPos | null {
  return current;
}

export function subscribeCursor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
