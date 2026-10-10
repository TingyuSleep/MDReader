/**
 * 欢迎页：没有打开任何文档时顶替工作区。
 *
 * 三件事：告诉用户能干什么（拖拽/快捷键）、给出两个主操作入口、
 * 列出最近文件（这是「本地优先」编辑器最常用的入口，值得占一屏）。
 *
 * 刻意**不做**最近文件的「是否还存在」预检：那需要每个文件发一次 IPC，
 * 结果还得处理「刚刚删掉但还没刷新」的时序。让点击时的错误来告诉你文件没了 ——
 * 后端返回的 NOT_FOUND 会带着具体路径显示出来，比一个灰掉的条目更有信息量。
 */
import {
  Code2,
  FileClock,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderTree,
  Pencil,
  Trash2,
} from "lucide-react";

import { isTauri } from "@tauri-apps/api/core";

import { dirName, fileName, pickMarkdownFile } from "@/lib/fs";
import { useEditor } from "@/store/editor";

export function Welcome() {
  const recentFiles = useEditor((state) => state.recentFiles);
  const open = useEditor((state) => state.open);
  const newDocument = useEditor((state) => state.newDocument);
  const removeRecent = useEditor((state) => state.removeRecent);
  const setNotice = useEditor((state) => state.setNotice);

  async function handleOpen(): Promise<void> {
    const picked = await pickMarkdownFile();
    if (!picked) {
      if (!isTauri()) setNotice("浏览器预览模式下没有原生文件对话框，请在桌面应用里使用");
      return;
    }
    await open(picked);
  }

  function handleNew(): void {
    newDocument();
  }

  function handleRecent(filePath: string): void {
    // 打开失败由 store 写 error，界面会显式提示，不在这里吞掉
    void open(filePath);
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-xl">
        {/* ---- 标题 ---- */}
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">MD阅读器</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            本地优先的 Markdown 编辑器 · 打开即改，改完即存
          </p>
        </div>

        {/* ---- 主操作 ---- */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => void handleOpen()}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <FolderOpen className="size-4" />
            打开文件
            <kbd className="rounded bg-primary-foreground/15 px-1.5 py-0.5 text-[11px]">Ctrl+O</kbd>
          </button>
          <button
            type="button"
            onClick={handleNew}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <FilePlus2 className="size-4" />
            新建文档
            <kbd className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Ctrl+N</kbd>
          </button>
        </div>

        {/* ---- 快速上手 ---- */}
        <ul className="mt-6 space-y-1.5 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <Pencil className="size-4 shrink-0 text-muted-foreground/70" />
            所见即所得：语法标记平时不显示，光标落到哪一段，哪一段就显形
          </li>
          <li className="flex items-center gap-2">
            <Code2 className="size-4 shrink-0 text-muted-foreground/70" />
            <span>
              按 <kbd className="rounded bg-muted px-1 py-0.5 text-[11px]">Ctrl+/</kbd>{" "}
              切到源码模式，看原样的 Markdown
            </span>
          </li>
          <li className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground/70" />
            把 <span className="font-mono text-foreground">.md</span> 文件直接拖进窗口即可打开
          </li>
          <li className="flex items-center gap-2">
            <FolderTree className="size-4 shrink-0 text-muted-foreground/70" />
            文档里的相对路径图片会按其所在目录自动解析
          </li>
        </ul>

        {/* ---- 最近文件 ---- */}
        <div className="mt-6">
          <div className="flex items-center gap-1.5 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <FileClock className="size-3.5" />
            最近打开
          </div>

          {recentFiles.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              还没有记录。打开过的文件会出现在这里。
            </p>
          ) : (
            <ul className="mt-2 space-y-0.5">
              {recentFiles.map((filePath) => (
                <li key={filePath} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleRecent(filePath)}
                    title={filePath}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className="truncate text-sm text-foreground">{fileName(filePath)}</span>
                    <span className="truncate text-xs text-muted-foreground">{dirName(filePath)}</span>
                  </button>
                  <button
                    type="button"
                    // tooltip 要带上文件名：列表里一排同样的图标，不指名道姓根本认不出删哪个
                    title={`从最近列表移除：${fileName(filePath)}（不会删除文件）`}
                    aria-label={`从最近列表移除 ${fileName(filePath)}`}
                    onClick={() => removeRecent(filePath)}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
