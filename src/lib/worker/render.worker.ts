/**
 * 渲染 Worker。
 *
 * 只干「解析 + 高亮」这件最贵的事（markdown-it + highlight.js），
 * 保证 1MB 级文档不阻塞主线程输入。
 *
 * 有意为之的两条边界：
 *   1. **不做清洗**。DOMPurify 在 Worker 里 isSupported=false，完全没有防护能力，
 *      清洗必须回主线程做。见 markdown-sanitize.ts 的 sanitizeHtml()。
 *   2. **不做图片地址转换**。convertFileSrc 依赖 window.__TAURI_INTERNALS__，
 *      Worker 里没有 window。见 asset-images.ts 的 resolveAssetImages()。
 *
 * 线程模型：请求方给每条消息一个自增 id，Worker 原样回传。Worker 不判断新旧 ——
 * 它按收到顺序串行处理，**丢弃过期结果由调用方按 id 决定**。这样 Worker 保持纯函数语义。
 */
import { parseMarkdown } from "@/lib/markdown-parse";
import type { AppError, TocItem } from "@/types";

// ------------------------------------------------------------ 消息协议

export interface RenderRequest {
  /** 调用方自增序号，用于丢弃过期结果 */
  id: number;
  type: "render";
  source: string;
}

export interface RenderSuccess {
  id: number;
  type: "rendered";
  /** 未清洗的 HTML，调用方必须过 sanitizeHtml() */
  html: string;
  toc: TocItem[];
  /** Worker 内部耗时（毫秒），用于性能观测 */
  ms: number;
  /** 源文长度，便于确认处理的确实是那一版内容 */
  sourceLength: number;
}

export interface RenderFailure {
  id: number;
  type: "error";
  error: AppError;
  ms: number;
}

export type RenderResponse = RenderSuccess | RenderFailure;

// ------------------------------------------------------------ Worker 主体

/**
 * 不写 `/// <reference lib="webworker" />`：那会把 webworker 的全局声明
 * 并进整个 tsconfig 的 lib，和已有的 DOM lib 打架（self / addEventListener 签名冲突）。
 * 这里自己声明用到的那一小撮接口，cast 一下就够了。
 */
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<RenderRequest>) => void): void;
  postMessage(message: RenderResponse): void;
}

const scope = self as unknown as WorkerScope;

function toAppError(err: unknown): AppError {
  if (err instanceof Error) {
    return { code: "UNKNOWN", message: err.message, detail: err.stack ?? null };
  }
  return { code: "UNKNOWN", message: "渲染失败", detail: String(err) };
}

scope.addEventListener("message", (event: MessageEvent<RenderRequest>) => {
  const request = event.data;
  if (!request || request.type !== "render") return;

  const startedAt = performance.now();

  try {
    const result = parseMarkdown(request.source);
    const response: RenderSuccess = {
      id: request.id,
      type: "rendered",
      html: result.html,
      toc: result.toc,
      ms: performance.now() - startedAt,
      sourceLength: request.source.length,
    };
    scope.postMessage(response);
  } catch (err) {
    // 解析失败必须显式回传 —— 前端要弹提示，不允许静默变空白
    console.error("[render.worker] 解析失败", err);
    const response: RenderFailure = {
      id: request.id,
      type: "error",
      error: toAppError(err),
      ms: performance.now() - startedAt,
    };
    scope.postMessage(response);
  }
});
