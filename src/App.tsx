/**
 * 应用外壳。
 *
 * 只做六件「没有任何子组件愿意承担」的事：
 *   1. 全局快捷键（Ctrl+O / Ctrl+N / Ctrl+Shift+S / Ctrl+F / Ctrl+/ / Esc）
 *   2. 拖拽打开文件（Tauri 的 onDragDropEvent 与浏览器的 HTML5 事件两条路径）
 *   3. 文件关联打开文件（双击 .md；冷启动参数走 State，已运行时走单实例转发的 open-file 事件）
 *   4. 布局编排（工具栏 + 工作区 + 状态栏 + 提示条）
 *   5. 离开文档前统一问一次「要不要放弃改动」
 *   6. 窗口标题跟随当前文档（`● 文件名 — MD阅读器`）
 *
 * 工作区是一栏：实时预览与源码模式的差别全部由 Editor 内部处理，
 * 这里不再需要为「分栏 / 纯预览」铺布局。
 * 也不再预热渲染 Worker —— 主界面已经没有独立预览面板，预热等于白拉一个 188 KB 的 chunk。
 *
 * 业务逻辑一律不写在这里：文件操作在 lib/fs，文档与渲染状态在 store，
 * 各功能区各自成组件。App 只负责把它们接起来。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, Info, X } from "lucide-react";

import { Editor, TOGGLE_FIND_EVENT } from "@/components/Editor";
import { FindReplace } from "@/components/FindReplace";
import { StatusBar } from "@/components/StatusBar";
import { Toolbar } from "@/components/Toolbar";
import { Welcome } from "@/components/Welcome";
import {
  confirmDiscardIfDirty,
  fileName,
  isMarkdownFile,
  pickMarkdownFile,
  pickSavePath,
} from "@/lib/fs";
import { cn } from "@/lib/utils";
import { REQUEST_PRINT_EVENT } from "@/lib/print";
import { useEditor, useIsDirty } from "@/store/editor";

/**
 * 从一组拖入路径里挑出第一个 Markdown 文件。
 *
 * 抽成纯函数是为了能单独验证：CDP 没法模拟真实的操作系统拖拽，
 * 但「挑选规则」本身是可以直接打靶的。
 */
export function pickFirstMarkdown(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (isMarkdownFile(path)) return path;
  }
  return null;
}

// ------------------------------------------------------------ 提示条

function Banner({
  tone,
  text,
  detail,
  onClose,
}: {
  tone: "error" | "info";
  text: string;
  detail?: string | null;
  onClose: () => void;
}) {
  const Icon = tone === "error" ? AlertTriangle : Info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex max-w-2xl items-start gap-2 rounded-lg border px-3 py-2 shadow-lg backdrop-blur",
        tone === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-popover text-popover-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="break-words">{text}</p>
        {detail && <p className="mt-0.5 text-xs opacity-80 break-words">{detail}</p>}
      </div>
      <button
        type="button"
        title="关闭提示"
        aria-label="关闭提示"
        onClick={onClose}
        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

// ------------------------------------------------------------ 主组件

export default function App() {
  const content = useEditor((state) => state.content);
  const path = useEditor((state) => state.path);
  const viewMode = useEditor((state) => state.viewMode);
  const error = useEditor((state) => state.error);
  const notice = useEditor((state) => state.notice);
  const open = useEditor((state) => state.open);
  const newDocument = useEditor((state) => state.newDocument);
  const saveAs = useEditor((state) => state.saveAs);
  const save = useEditor((state) => state.save);
  const setError = useEditor((state) => state.setError);
  const setNotice = useEditor((state) => state.setNotice);
  const dismissNotice = useEditor((state) => state.dismissNotice);
  const setViewMode = useEditor((state) => state.setViewMode);

  const dirty = useIsDirty();
  const [findOpen, setFindOpen] = useState(false);

  // 没有打开任何文件、也没有内容 → 欢迎页
  const showWelcome = useMemo(() => path === null && content.length === 0, [path, content]);

  // ---- 提示条自动消失（错误不自动消失，得让用户看到）
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 4500);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  // 切到欢迎页时收起查找面板，否则它会在新文档上悬着
  useEffect(() => {
    if (showWelcome) setFindOpen(false);
  }, [showWelcome]);

  /*
    ---- 窗口标题跟随当前文档

    任务栏与窗口列表里只有标题可用，始终显示「MD阅读器」的话，同时开两份文档
    就分不清哪个是哪个。未保存标记放在最前面也是这个原因 —— 标题在任务栏会被
    从右侧截断，文件名比标记长得多。

    ⚠ **Tauri v2 不会把 `document.title` 同步到窗口标题**。实测：只改
    `document.title`，`MainWindowTitle` 依然是配置里那个「MD阅读器」，纹丝不动。
    必须显式调 `getCurrentWindow().setTitle()`；`document.title` 那行留着是因为
    它管的是 WebView 内部的文档标题，且浏览器环境下只有它能设。

    权限：这条 API 需要 `core:window:allow-set-title`（不在 `core:default` 里），
    见 src-tauri/capabilities/default.json。

    标题设失败不影响编辑，降级成一条 console.warn，不打断用户。
  */
  useEffect(() => {
    const name = path ? fileName(path) : "未命名文档";
    const title = `${dirty ? "● " : ""}${name} — MD阅读器`;
    document.title = title;

    if (!isTauri()) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
      .catch((err: unknown) => {
        console.warn("[app] 设置窗口标题失败", err);
      });
  }, [path, dirty]);

  // ---- 编辑区通过事件请求打开查找面板（keymap 回调拿不到 React 状态）
  useEffect(() => {
    const onToggle = (): void => setFindOpen((value) => !value);
    window.addEventListener(TOGGLE_FIND_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_FIND_EVENT, onToggle);
  }, []);

  // ---- 离开当前文档前的统一确认
  const guardDirty = useCallback(
    async (action: string): Promise<boolean> => {
      const decision = await confirmDiscardIfDirty(dirty, action);
      if (decision === "cancel") return false;
      if (decision === "unsupported") {
        setNotice(`当前文档有未保存的改动，请先保存（Ctrl+S）再${action}`);
        return false;
      }
      return true;
    },
    [dirty, setNotice],
  );

  const handleOpenDialog = useCallback(async (): Promise<void> => {
    try {
      const picked = await pickMarkdownFile();
      if (!picked) return;
      if (!(await guardDirty("打开其它文件"))) return;
      setFindOpen(false);
      await open(picked);
    } catch (err) {
      setError({
        code: "UNKNOWN",
        message: "打开文件失败",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [guardDirty, open, setError]);

  const handleNewDocument = useCallback(async (): Promise<void> => {
    if (!(await guardDirty("新建文档"))) return;
    setFindOpen(false);
    newDocument();
  }, [guardDirty, newDocument]);

  const handleSaveAsDialog = useCallback(async (): Promise<void> => {
    try {
      const picked = await pickSavePath(path);
      if (!picked) return;
      await saveAs(picked);
    } catch (err) {
      setError({
        code: "UNKNOWN",
        message: "保存失败",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [path, saveAs, setError]);

  // ---- 全局快捷键
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // 编辑区的 keymap 会先处理并 preventDefault。不跳过的话，
      // Ctrl+F 会被处理两次（CM 发事件 + 这里再切一次），等于没反应。
      if (event.defaultPrevented) return;

      const mod = event.ctrlKey || event.metaKey;

      if (!mod) {
        if (event.key !== "Escape") return;
        // Esc 逐层退：先关面板，再消提示
        if (findOpen) {
          setFindOpen(false);
          event.preventDefault();
        } else if (error) {
          setError(null);
          event.preventDefault();
        } else if (notice) {
          dismissNotice();
          event.preventDefault();
        }
        return;
      }

      switch (event.key.toLowerCase()) {
        case "o":
          event.preventDefault();
          void handleOpenDialog();
          break;
        case "n":
          event.preventDefault();
          void handleNewDocument();
          break;
        case "f":
          event.preventDefault();
          setFindOpen((value) => !value);
          break;
        case "s":
          // 焦点在编辑区时这条走不到（CM 已 preventDefault 并接管）
          event.preventDefault();
          if (event.shiftKey) void handleSaveAsDialog();
          else void save();
          break;
        case "/":
          // 实时预览 ↔ 源码。焦点在编辑区时由 CM 的 keymap 接管，这里兜住其余情况
          // （焦点在工具栏按钮、欢迎页按钮上时按 Ctrl+/ 也该管用）。
          event.preventDefault();
          setViewMode(viewMode === "source" ? "live" : "source");
          break;
        case "p":
          /*
            打印。只做转发，不在这里实现 —— 打印的容器与样式表在 lib/print，
            入口和 loading 态在工具栏，这里再写一份必然和那边不一致。

            ⚠ 本机 Tauri（2.12）没有暴露 WebView2 的 AreBrowserAcceleratorKeysEnabled，
            wry 默认开着浏览器快捷键，所以**系统有可能先一步吃掉 Ctrl+P**，
            那样这段代码根本不会执行。工具栏的「打印」按钮才是保证路径。
          */
          event.preventDefault();
          window.dispatchEvent(new Event(REQUEST_PRINT_EVENT));
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    findOpen,
    error,
    notice,
    viewMode,
    setViewMode,
    dismissNotice,
    handleOpenDialog,
    handleNewDocument,
    handleSaveAsDialog,
    save,
    setError,
  ]);

  // ---- 拖拽打开
  useEffect(() => {
    const handlePaths = (paths: readonly string[]): void => {
      const target = pickFirstMarkdown(paths);
      if (!target) {
        setNotice(
          paths.length > 0
            ? `拖入的文件里没有 .md / .markdown（收到 ${paths.length} 个路径）`
            : "没有识别到拖入的文件路径",
        );
        return;
      }
      void (async () => {
        if (!(await guardDirty("打开其它文件"))) return;
        setFindOpen(false);
        await open(target);
      })();
    };

    if (!isTauri()) {
      // 浏览器里拿不到 File 的绝对路径，与其猜不如明说
      const onDragOver = (event: DragEvent): void => event.preventDefault();
      const onDrop = (event: DragEvent): void => {
        event.preventDefault();
        if (event.dataTransfer?.files.length) {
          setNotice("浏览器预览模式下拿不到拖入文件的完整路径，请在桌面应用里拖拽");
        }
      };
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onDrop);
      return () => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
      };
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        // 动态 import：这条路径只在桌面端走，没必要进主包首屏
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          handlePaths(event.payload.paths);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (err) {
        setError({
          code: "UNKNOWN",
          message: "拖拽功能初始化失败",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [guardDirty, open, setError, setNotice]);

  // ---- 文件关联：双击 .md 打开（含启动参数）
  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const openPath = (path: string): void => {
      if (!isMarkdownFile(path)) return;
      void (async () => {
        if (!(await guardDirty("打开其它文件"))) return;
        setFindOpen(false);
        await open(path);
      })();
    };

    void (async () => {
      try {
        // 动态 import：这条路径只在桌面端走，没必要进主包首屏
        const [{ invoke }, { listen }] = await Promise.all([
          import("@tauri-apps/api/core"),
          import("@tauri-apps/api/event"),
        ]);

        /*
          两条来路，顺序不能反。

          冷启动（exe 后面直接跟路径）：前端此刻才刚挂载，后端**早就**在 .run() 之前
          把路径解析好了。那时还没有人在 listen，emit 必丢 —— 所以是后端先存进 State，
          这里主动取一次。反过来「先 listen 再取」也不会错，但先取能少一次无谓的等待。
        */
        const pending = await invoke<string | null>("take_pending_open_path");
        if (disposed) return;
        if (pending) openPath(pending);

        // 应用已经在运行时又双击了一个文件：单实例插件把 argv 转过来，这里收
        const stop = await listen<string>("open-file", (event) => {
          openPath(event.payload);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (err) {
        setError({
          code: "UNKNOWN",
          message: "文件关联初始化失败",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [guardDirty, open, setError]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <Toolbar />

      <main className="relative flex min-h-0 flex-1">
        {showWelcome ? (
          <div className="min-w-0 flex-1">
            <Welcome />
          </div>
        ) : (
          // 单栏。实时预览与源码模式的差别在 Editor 内部，这里不铺第二条轨道。
          <section className="relative min-w-0 flex-1 overflow-hidden">
            <Editor />
            {findOpen && (
              <FindReplace
                content={content}
                onClose={() => setFindOpen(false)}
                onNotice={setNotice}
              />
            )}
          </section>
        )}

        {/* ---- 提示条 ---- */}
        {(error || notice) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4">
            {error && (
              <Banner
                tone="error"
                text={error.message}
                detail={error.detail}
                onClose={() => setError(null)}
              />
            )}
            {notice && <Banner tone="info" text={notice} onClose={dismissNotice} />}
          </div>
        )}
      </main>

      <StatusBar />
    </div>
  );
}
