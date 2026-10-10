/**
 * 编辑器全局状态。
 *
 * 这里同时承担了「渲染 Worker 的调用方」这个角色：
 *   - Worker 实例、请求序号、防抖计时器都是模块级单例，不放进 store state
 *     （它们是实现细节，不是可观察状态；放进去只会让每次 set 都触发无用渲染）
 *   - 过期结果的丢弃靠自增 token 对账，见 runRender()
 *
 * 整个文件里唯一允许碰 DOM 的地方是 sanitizeHtml() —— DOMPurify 必须在主线程跑。
 */
import { create } from "zustand";

import {
  openDocument as openDocumentFromDisk,
  toAppError,
  writeFile as writeFileToDisk,
} from "@/lib/fs";
import {
  dropRecentFile,
  loadRecentFiles,
  MAX_RECENT_FILES,
  pushRecentFile,
  saveRecentFiles,
} from "@/lib/recent";
import type { RenderRequest, RenderResponse } from "@/lib/worker/render.worker";
import type { AppError, EolStyle, SaveResult, TextEncoding, TocItem } from "@/types";

/**
 * 预览渲染上限 256 KB。
 *
 * 批次 2 实测（headless Chrome，本机）：64KB→71ms、256KB→194ms、1MB→715ms，
 * 且 1MB 时主线程清洗单独就要 435ms，远超「输入延迟 ≤ 50ms」的目标。
 * 取 256 KB 正好卡在 200ms 拐点之前，超出部分按整行截断并显式告知用户。
 */
export const PREVIEW_MAX_BYTES = 256 * 1024;

/** 打字停顿多久后刷新预览 */
const PREVIEW_DEBOUNCE_MS = 220;

/** 最近文件保留条数（真身在 src/lib/recent.ts，这里转出去让旧引用点继续可用） */
export { MAX_RECENT_FILES };

/**
 * 视图模式。
 *
 * 只有两态，和 Typora 一致：
 *   - `live`   实时预览 —— 语法标记平时藏起来，光标落上去才显形，同一栏里直接读直接改
 *   - `source` 源码模式 —— 完全原样的编辑区，标记一个字都不藏
 *
 * 原来的 `edit | split | preview` 三态随左右分栏一起去掉了：Live Preview 本身就是
 * 「读」与「改」合一，再摆一个并排的预览面板只会压缩正文宽度。
 */
export type ViewMode = "live" | "source";

// ------------------------------------------------------------ Worker 客户端

let worker: Worker | null = null;
let requestSeq = 0;

function ensureWorker(): Worker {
  worker ??= new Worker(new URL("../lib/worker/render.worker.ts", import.meta.url), {
    type: "module",
  });
  return worker;
}

/**
 * 发一次渲染请求。
 *
 * 每条请求挂自己的 message 监听并按 id 过滤，所以过期结果只会被丢弃，
 * 不会串台到后来的请求上。
 */
function renderInWorker(source: string): Promise<RenderResponse> {
  const instance = ensureWorker();
  const id = ++requestSeq;

  return new Promise<RenderResponse>((resolve) => {
    const onMessage = (event: MessageEvent<RenderResponse>): void => {
      if (event.data?.id !== id) return;
      instance.removeEventListener("message", onMessage);
      resolve(event.data);
    };
    instance.addEventListener("message", onMessage);

    const request: RenderRequest = { id, type: "render", source };
    instance.postMessage(request);
  });
}

let warmedUp = false;

/**
 * 预热渲染 Worker。
 *
 * 冷启动要加载 markdown-it + highlight.js，实测约 45ms。在应用启动时先跑一遍空渲染，
 * 免得用户敲下第一个字才平白迟一下。预热结果直接丢弃，不参与任何状态。
 */
export function warmupRenderer(): void {
  if (warmedUp) return;
  warmedUp = true;
  void renderInWorker("");
}

// ------------------------------------------------------------ 截断

const encoder = new TextEncoder();

interface Truncated {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/**
 * 超出上限时按**整行**截断。
 *
 * 逐行累加字节数并在超限时立刻 break，所以不会遍历完整篇大文档；
 * 按整行切是为了不切在半个字符或半个代码围栏中间。
 */
function truncateForPreview(source: string): Truncated {
  const totalBytes = encoder.encode(source).length;
  if (totalBytes <= PREVIEW_MAX_BYTES) {
    return { text: source, truncated: false, totalBytes };
  }

  const kept: string[] = [];
  let bytes = 0;

  for (const line of source.split("\n")) {
    const lineBytes = encoder.encode(line).length + 1; // +1 是换行符
    if (bytes + lineBytes > PREVIEW_MAX_BYTES) break;
    kept.push(line);
    bytes += lineBytes;
  }

  return { text: kept.join("\n"), truncated: true, totalBytes };
}

// ------------------------------------------------------------ store

interface EditorState {
  // ---- 文档
  /** 当前文档绝对路径；null 表示还没落过盘 */
  path: string | null;
  content: string;
  /** 最后一次成功写盘的内容，用来判断 dirty（而不是靠布尔标记，避免漏置位） */
  savedContent: string;
  encoding: TextEncoding | null;
  eol: EolStyle | null;
  hasBom: boolean;
  /** 每次打开/新建自增；Editor 靠它判断要不要整体替换文档 */
  documentId: number;

  // ---- 预览
  /**
   * 是否在后台跑渲染管线。
   *
   * Live Preview 上线后主界面不再有独立的预览面板，渲染默认**关闭** ——
   * 否则每敲一段字就会白发一次 Worker 请求（256 KB 文档实测 194 ms 解析 + 主线程清洗），
   * 纯属浪费。
   *
   * 管线本身保留：一是验收套件覆盖着它（47 条断言），二是后面接「导出 HTML」
   * 或独立预览窗口时不用从零再写一遍。需要时把它置 true 即可。
   */
  previewEnabled: boolean;
  html: string;
  toc: TocItem[];
  rendering: boolean;
  /** 已完成的渲染次数。单调递增，比 rendering 布尔更适合做「等一次渲染结束」的判据 */
  renderCount: number;
  /** 最近一次 Worker 内部耗时（毫秒），供状态栏与排查用 */
  lastRenderMs: number | null;
  /** 预览是否因为超过体积上限被截断 */
  truncated: boolean;
  totalBytes: number;

  // ---- 交互状态
  error: AppError | null;
  notice: string | null;
  saving: boolean;
  lastSavedAt: number | null;
  recentFiles: string[];

  /** 布局：实时预览 / 源码。放在这里是为了让工具栏与 App 共享一份，避免属性钻取。 */
  viewMode: ViewMode;

  // ---- 动作
  open: (filePath: string) => Promise<void>;
  setContent: (next: string) => void;
  save: () => Promise<SaveResult | null>;
  saveAs: (nextPath: string) => Promise<SaveResult | null>;
  /** 清空编辑器开始新文档（不落盘，等用户自己另存为） */
  newDocument: () => void;
  close: () => void;
  setViewMode: (mode: ViewMode) => void;
  /** 从最近文件里剔除一条（文件被删/改名后手动清理） */
  removeRecent: (filePath: string) => void;
  setError: (error: AppError | null) => void;
  setNotice: (notice: string | null) => void;
  dismissNotice: () => void;
}

export const useEditor = create<EditorState>((set, get) => {
  // 自增令牌：响应回来时对不上说明期间又改了内容，直接作废
  let renderToken = 0;
  // 在途渲染计数：rendering 标志由它驱动。
  // 不能靠 token 判断「该不该复位」—— 关文档时 token 会自增，
  // 在途结果被作废后没人负责把标志放下来，loading 就永久卡住了（踩过一次）。
  let inFlight = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function runRender(): Promise<void> {
    const token = ++renderToken;
    const { text, truncated, totalBytes } = truncateForPreview(get().content);

    inFlight += 1;
    set({ rendering: true });

    try {
      const response = await renderInWorker(text);
      if (token !== renderToken) return; // 期间内容又变了，这次结果作废

      if (response.type === "error") {
        set((state) => ({
          renderCount: state.renderCount + 1,
          lastRenderMs: response.ms,
          error: response.error,
        }));
        return;
      }

      /*
        清洗只能在主线程做（DOMPurify 在 Worker 里 isSupported=false）。

        动态 import：DOMPurify 有 47 KB，而渲染管线默认是关的（主界面已没有独立预览面板）。
        静态引入等于让每个用户都为一条用不到的路付首屏开销；按需拉取之后
        它会被拆成独立 chunk，只有真正打开 previewEnabled 才会下载。
      */
      const { sanitizeHtml } = await import("@/lib/markdown-sanitize");
      const safeHtml = sanitizeHtml(response.html);
      if (token !== renderToken) return;

      set((state) => ({
        html: safeHtml,
        toc: response.toc,
        renderCount: state.renderCount + 1,
        lastRenderMs: response.ms,
        truncated,
        totalBytes,
        error: null,
      }));
    } catch (err) {
      if (token !== renderToken) return;
      set((state) => ({
        renderCount: state.renderCount + 1,
        error: toAppError(err),
      }));
    } finally {
      inFlight -= 1;
      if (inFlight <= 0) {
        inFlight = 0;
        set({ rendering: false });
      }
    }
  }

  function scheduleRender(delay = PREVIEW_DEBOUNCE_MS): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runRender();
    }, delay);
  }

  function rememberRecent(filePath: string): void {
    // 先算好新列表再一次性写入：pushRecentFile 是纯函数，结果确定，
    // 不需要在 set 的 reducer 里做副作用。
    const next = pushRecentFile(get().recentFiles, filePath);
    set({ recentFiles: next });
    saveRecentFiles(next);
  }

  /** 复位成「没有打开任何文档」的状态。close 与 newDocument 共用。 */
  function resetDocument(): void {
    // 让在途的渲染结果全部作废，否则关掉文档后旧内容可能又刷回预览
    renderToken += 1;
    set({
      path: null,
      content: "",
      savedContent: "",
      encoding: null,
      eol: null,
      hasBom: false,
      documentId: get().documentId + 1,
      html: "",
      toc: [],
      truncated: false,
      totalBytes: 0,
      error: null,
      notice: null,
    });
  }

  return {
    path: null,
    content: "",
    savedContent: "",
    encoding: null,
    eol: null,
    hasBom: false,
    documentId: 0,

    html: "",
    toc: [],
    previewEnabled: false,
    rendering: false,
    renderCount: 0,
    lastRenderMs: null,
    truncated: false,
    totalBytes: 0,

    error: null,
    notice: null,
    saving: false,
    lastSavedAt: null,
    // 启动时从 localStorage 恢复，跨会话保留
    recentFiles: loadRecentFiles(),
    viewMode: "live",

    open: async (filePath) => {
      set({ error: null, notice: null });
      try {
        // openDocument 顺带把所在目录加进 asset 白名单
        const file = await openDocumentFromDisk(filePath);
        set({
          path: file.path,
          content: file.content,
          savedContent: file.content,
          encoding: file.encoding,
          eol: file.eol,
          hasBom: file.hasBom,
          documentId: get().documentId + 1,
        });
        rememberRecent(file.path);
        if (get().previewEnabled) scheduleRender(0);
      } catch (err) {
        set({ error: toAppError(err) });
      }
    },

    setContent: (next) => {
      if (next === get().content) return;
      set({ content: next });
      if (get().previewEnabled) scheduleRender();
    },

    save: async () => {
      const { path: currentPath, content, saving } = get();

      // 防重入：Ctrl+S 可能在编辑器 keymap 和全局监听上各绑一次
      if (saving) return null;

      if (!currentPath) {
        set({ notice: "文档还没有保存路径，请使用「另存为」" });
        return null;
      }

      set({ saving: true });
      try {
        const result = await writeFileToDisk(currentPath, content);
        set({
          saving: false,
          savedContent: content,
          lastSavedAt: Date.now(),
          error: null,
          // 内容没变时后端不会落盘，明确告诉用户，别让人以为保存失败了
          notice: result.written ? null : "内容与磁盘一致，已跳过写入",
        });
        return result;
      } catch (err) {
        set({ saving: false, error: toAppError(err) });
        return null;
      }
    },

    saveAs: async (nextPath) => {
      const { content, saving } = get();
      if (saving) return null;

      set({ saving: true });
      try {
        const result = await writeFileToDisk(nextPath, content);
        set({
          saving: false,
          path: result.path,
          savedContent: content,
          lastSavedAt: Date.now(),
          error: null,
          notice: null,
        });
        rememberRecent(result.path);
        return result;
      } catch (err) {
        set({ saving: false, error: toAppError(err) });
        return null;
      }
    },

    close: () => resetDocument(),

    // 与 close() 状态复位完全一致，只是语义不同（新建 vs 关闭）。
    // 没有路径，所以 Ctrl+S 会提示走「另存为」——这是刻意的，
    // 不在这里擅自弹保存框，避免吞掉用户的未保存内容。
    newDocument: () => resetDocument(),

    setViewMode: (mode) => set({ viewMode: mode }),

    removeRecent: (filePath) => {
      const next = dropRecentFile(get().recentFiles, filePath);
      set({ recentFiles: next });
      saveRecentFiles(next);
    },

    setError: (error) => set({ error }),
    setNotice: (notice) => set({ notice }),
    dismissNotice: () => set({ notice: null }),
  };
});

// ------------------------------------------------------------ 派生状态

/** 是否有未保存改动 */
export function useIsDirty(): boolean {
  return useEditor((state) => state.content !== state.savedContent);
}
