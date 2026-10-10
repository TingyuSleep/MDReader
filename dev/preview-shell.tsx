/**
 * 预览外壳（dev-only，用完即删）。
 *
 * 存在的唯一理由：截图脚本需要把界面驱动到「已经打开一篇文档」的状态，
 * 而浏览器里没有 Tauri invoke，`store.open()` 走不通（拿不到文件路径）。
 * 所以这里挂载真正的 <App/>，并把 store 挂到 window 上供外部注入内容。
 *
 * 与产品代码零耦合：App 里没有任何一行是为它服务的。
 */
import "@/index.css";

import { createRoot } from "react-dom/client";

import App from "@/App";
import { getActiveEditorView } from "@/components/Editor";
import { setThemeMode, type ThemeMode } from "@/hooks/useTheme";
import { useEditor, type ViewMode } from "@/store/editor";

const host = document.createElement("div");
host.style.cssText = "position:fixed;inset:0;overflow:hidden";
document.body.append(host);

createRoot(host).render(<App />);

/**
 * 外部注入一篇文档。等价于「打开了一个文件」，只是绕过了磁盘读取。
 *
 * 关键是必须同时推进 `documentId` —— Editor 靠它判断要不要整体替换 doc。
 * 只写 content 而不动 documentId，编辑区会停在空白（踩过一次）。
 */
(window as unknown as Record<string, unknown>).__openDemo = (text: string, path: string): void => {
  const state = useEditor.getState();
  useEditor.setState({
    path,
    content: text,
    savedContent: text,
    documentId: state.documentId + 1,
    error: null,
    notice: null,
  });
};

/** 制造「有未保存改动」的状态，用来截工具栏的脏标记 */
(window as unknown as Record<string, unknown>).__makeDirty = (): void => {
  useEditor.setState({ content: `${useEditor.getState().content}\n\n（刚刚敲进去的一行）` });
};

/** 切视图模式（live / source），用来分别截图两种观感 */
(window as unknown as Record<string, unknown>).__setViewMode = (mode: string): void => {
  useEditor.getState().setViewMode(mode as ViewMode);
};

/** 切主题模式（light / dark / system），用来分别核对浅色与深色下的观感 */
(window as unknown as Record<string, unknown>).__setTheme = (mode: string): void => {
  setThemeMode(mode as ThemeMode);
};

/**
 * 把光标放到指定位置，用来截「标记显形」那一刻。
 *
 * 实时预览的核心交互就是「光标落在哪，哪一段的语法标记就显形」，
 * 光截一张静态图看不出这回事，必须真的把光标放进去。
 */
(window as unknown as Record<string, unknown>).__selectInEditor = (
  from: number,
  to: number,
): void => {
  const view = getActiveEditorView();
  view?.dispatch({ selection: { anchor: from, head: to } });
  view?.focus();
};

/** 读当前选区范围 —— 用来判定「鼠标拖选到底有没有真的生效」 */
(window as unknown as Record<string, unknown>).__getSelection = (): {
  from: number;
  to: number;
  empty: boolean;
} | null => {
  const view = getActiveEditorView();
  if (!view) return null;
  const { from, to, empty } = view.state.selection.main;
  return { from, to, empty };
};

/** 读当前文档正文。断言「删掉了什么」要用它 —— 直接读 DOM 会被装饰层干扰。 */
(window as unknown as Record<string, unknown>).__getDoc = (): string | null => {
  const view = getActiveEditorView();
  return view ? view.state.doc.toString() : null;
};

/**
 * 某个文档位置在视口中的坐标。
 *
 * 给探针脚本用：CDP 的 `Input.dispatchMouseEvent` 只认视口坐标，
 * 而我们要按「第几个字符」来派发鼠标事件，得先把位置换成坐标。
 */
(window as unknown as Record<string, unknown>).__coordsAt = (
  pos: number,
): { x: number; y: number } | null => {
  const view = getActiveEditorView();
  if (!view) return null;
  const rect = view.coordsAtPos(pos);
  if (!rect) return null;
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
};

(window as unknown as Record<string, unknown>).__ready = true;
