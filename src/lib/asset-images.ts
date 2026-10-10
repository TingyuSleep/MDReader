/**
 * 把渲染产物里的 `data-md-src` 换成 WebView 真能加载的 `asset://` 地址。
 *
 * 为什么单独一个模块，而不是留在 markdown-sanitize.ts 里：
 *
 * 它和 DOMPurify **没有任何关系**（只用到 `convertFileSrc` 和纯字符串路径工具），
 * 但它同样只能在主线程跑。放在清洗模块里会让所有 import 它的人**顺手把 DOMPurify
 * 拖进首屏主包** —— 打印就是这么撞上的：`print.ts` 为了解析图片静态引了
 * markdown-sanitize，vite 立刻报
 * `INEFFECTIVE_DYNAMIC_IMPORT: markdown-sanitize is dynamically imported by
 * export-html.ts but also statically imported by print.ts`，
 * 原本靠动态 import 挡在主包外的约 29 KB 清洗库就这么漏了进去。
 *
 * 拆开之后：要清洗的走 markdown-sanitize（保持动态加载），要换图片地址的走这里。
 *
 * 调用时机固定：**必须在 innerHTML 之后** —— 渲染期刻意只写 `data-md-src`
 * 不写 `src`，免得 WebView 去请求一个必然 404 的相对地址。
 */
import { isTauri } from "@tauri-apps/api/core";

import { toAssetUrl } from "./fs";
import { resolveRelativePath } from "./markdown-path";

/**
 * 把 root 内所有 `img[data-md-src]` 的地址解析出来并写回 `src`。
 *
 * 返回修正的图片数量，便于测试与排查。
 * 单张图失败只告警不抛错：一张图挂掉不该让整篇文档打不开。
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
