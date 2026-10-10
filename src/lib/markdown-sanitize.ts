/**
 * 渲染管线 · 第二段：清洗。**必须在主线程执行**。
 *
 * 这个模块是主线程在渲染链路上唯一的依赖，刻意只带 DOMPurify（约 47 KB）。
 * 解析器（markdown-it + highlight.js，约 217 KB）在 markdown-parse.ts 里，
 * 只有 Worker 会引 —— 别在这里 import 它。
 *
 * 第三段「图片地址重写」**已经搬去 asset-images.ts**：它和 DOMPurify 毫无关系，
 * 留在本模块里会让任何 import 它的人顺手把 DOMPurify 拖进首屏主包（打印踩过一次）。
 * 本模块也不要 import 它，否则又会绕回来。
 *
 * 必须有 DOM / window：DOMPurify 在 Worker 里 isSupported=false，起不到任何防护作用。
 *
 * 调用顺序固定为：parse（Worker）→ sanitize（主线程）→ 塞进 DOM → resolveAssetImages（主线程）
 */
import DOMPurify, { type Config } from "dompurify";

/** 允许保留的属性白名单 */
const SANITIZE_CONFIG: Config = {
  // DOMPurify 默认会剥掉所有 data-*，不在 ADD_ATTR 里显式列出来就白写
  ADD_ATTR: ["rel", "loading", "decoding", "data-md-link", "data-md-src", "data-lang"],
  ALLOW_DATA_ATTR: true,
  // html profile 覆盖了绝大部分标签（含任务列表需要的 <input>），
  // 再显式禁掉能发起请求 / 提交 / 嵌入的标签。
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "iframe", "frame", "object", "embed", "base", "link", "meta", "svg", "math"],
  FORBID_ATTR: ["style", "srcset", "formaction", "ping", "onerror", "onload"],
};

/**
 * 清洗一段由 markdown-it 产出的 HTML。
 *
 * 走到这里 DOMPurify 还不可用，说明架构用错了（例如在 Worker 里调用了它），
 * 这时宁可抛错也不能把未清洗的 HTML 放出去 —— 不允许静默失败。
 */
export function sanitizeHtml(dirty: string): string {
  if (!DOMPurify.isSupported) {
    throw new Error("DOMPurify 不可用：HTML 清洗必须在有 DOM 的主线程执行，不能放进 Web Worker");
  }
  return DOMPurify.sanitize(dirty, SANITIZE_CONFIG);
}
