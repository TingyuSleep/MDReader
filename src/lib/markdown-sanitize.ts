/**
 * 渲染管线 · 第二、三段：清洗 + 图片地址重写。**必须在主线程执行**。
 *
 * 这个模块是主线程在渲染链路上唯一的依赖，刻意只带 DOMPurify（约 47 KB）。
 * 解析器（markdown-it + highlight.js，约 217 KB）在 markdown-parse.ts 里，
 * 只有 Worker 会引 —— 别在这里 import 它。
 *
 * 两段都必须有 DOM / window：
 *   - DOMPurify 在 Worker 里 isSupported=false，起不到任何防护作用；
 *   - convertFileSrc 依赖 window.__TAURI_INTERNALS__。
 *
 * 调用顺序固定为：parse（Worker）→ sanitize（主线程）→ 塞进 DOM → resolveAssetImages（主线程）
 */
import DOMPurify, { type Config } from "dompurify";
import { isTauri } from "@tauri-apps/api/core";

import { toAssetUrl } from "./fs";
import { resolveRelativePath } from "./markdown-path";

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

/**
 * 把 data-md-src 的相对路径解析成 asset:// URL 并写回 src。
 *
 * 必须在 innerHTML 之后再调用。返回修正的图片数量，便于测试与排查。
 */
export function resolveAssetImages(root: ParentNode, baseDir: string): number {
  const images = root.querySelectorAll<HTMLImageElement>("img[data-md-src]");
  let fixed = 0;

  for (const img of images) {
    const raw = img.getAttribute("data-md-src");
    if (!raw) continue;

    const absolute = resolveRelativePath(baseDir, raw);
    img.removeAttribute("data-md-src");

    if (!isTauri()) {
      // 纯浏览器里跑 dev server 的降级路径：asset 协议不存在，退回相对路径碰运气
      img.setAttribute("src", raw);
      fixed += 1;
      continue;
    }

    try {
      img.setAttribute("src", toAssetUrl(absolute));
      fixed += 1;
    } catch (err) {
      console.warn("[markdown] 图片地址转换失败", absolute, err);
    }
  }

  return fixed;
}
