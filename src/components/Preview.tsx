/**
 * 预览区 —— **当前没有 UI 入口，但请勿删除**。
 *
 * 主界面在批次 6 改成了 Typora 式单栏所见即所得（标记藏在编辑区里就地渲染），
 * 不再有并排的预览面板，所以 App 里已经不引用本组件了。
 * 保留它有明确理由：`dev/verify-editor.tsx` 的 34 条断言正在覆盖这条链路，
 * 未来的「导出 HTML / 打印 / 独立预览窗口」也仍然要复用同一套渲染管线
 * （store 的 `runRender` + render.worker + markdown-sanitize）。
 *
 * 想看它的效果：`store.previewEnabled = true` 之后再由任意容器挂载即可。
 *
 * 安全边界（这是本项目最敏感的一段代码，改动前务必读完）：
 *   - 唯一入口是 store 里已经过 DOMPurify 的 `html`，本组件**不做任何清洗**，
 *     也不接受任何未经清洗的输入。用 dangerouslySetInnerHTML 是 React 侧
 *     注入已清洗 HTML 的标准做法，比手写 container.innerHTML 更可控。
 *   - 所有链接在渲染期就被打上 data-md-link 标记，点击一律 preventDefault，
 *     **绝不允许 WebView 自行导航**（外链转系统浏览器，锚点在预览区内滚动）。
 *   - 图片的相对路径在解析期只挂 data-md-src，这里再按文档目录换成 asset:// URL。
 */
import { useCallback, useEffect, useRef, type MouseEvent } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import { dirName } from "@/lib/fs";
import { resolveAssetImages } from "@/lib/markdown-sanitize";
import { formatBytes } from "@/lib/utils";
import { useEditor } from "@/store/editor";

export function Preview() {
  const html = useEditor((state) => state.html);
  const path = useEditor((state) => state.path);
  const truncated = useEditor((state) => state.truncated);
  const totalBytes = useEditor((state) => state.totalBytes);
  const error = useEditor((state) => state.error);
  const setNotice = useEditor((state) => state.setNotice);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const baseDir = path ? dirName(path) : "";

  // ---- 把相对路径图片换成 asset:// URL（必须在 HTML 进 DOM 之后）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !baseDir) return;
    resolveAssetImages(container, baseDir);
  }, [html, baseDir]);

  // ---- 链接点击拦截
  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest("a[data-md-link]");
      if (!anchor) return;

      // 一律拦住：Tauri 里任何 WebView 内导航都是不可接受的
      event.preventDefault();

      const href = anchor.getAttribute("href") ?? "";
      if (!href) return;

      // 文档内锚点 → 在预览区里滚动
      if (href.startsWith("#")) {
        const id = decodeURIComponent(href.slice(1));
        const heading = containerRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
        if (heading instanceof HTMLElement) {
          heading.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          setNotice(`找不到锚点：${href}`);
        }
        return;
      }

      // 外链 → 交给系统默认浏览器
      if (/^(?:https?|mailto|tel):/i.test(href) || href.startsWith("//")) {
        void openUrl(href).catch(() => {
          setNotice(`无法用系统浏览器打开：${href}`);
        });
        return;
      }

      // 相对路径 / 本地文件链接：MVP 不做跳转，但要明确告知，不能悄无声息
      setNotice(`暂不支持从预览区跳转本地文件：${href}`);
    },
    [setNotice],
  );

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--preview-bg)]">
      {truncated && (
        <div
          role="status"
          className="shrink-0 border-b border-[var(--border)] bg-[var(--accent)] px-4 py-2 text-xs text-[var(--muted-foreground)]"
        >
          文档共 {formatBytes(totalBytes)}，超出预览上限，此处只渲染了前 256 KB。
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[var(--border)] bg-[var(--destructive)]/10 px-4 py-2 text-xs text-[var(--destructive)]"
        >
          {error.message}
          {error.detail ? `（${error.detail}）` : ""}
        </div>
      )}

      <div
        ref={containerRef}
        onClick={handleClick}
        className="markdown-body scrollbar-thin min-h-0 flex-1 overflow-auto px-8 py-6"
        // 内容已在 store 侧过 DOMPurify，见文件头注释
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {!html && !error && (
        <div className="pointer-events-none absolute inset-x-0 top-6 text-center text-sm text-[var(--muted-foreground)]">
          预览会实时显示在这里
        </div>
      )}
    </div>
  );
}
