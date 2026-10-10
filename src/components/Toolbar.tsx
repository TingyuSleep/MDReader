/**
 * 顶部工具栏：文件操作 + 视图布局 + 主题切换。
 *
 * 设计约束：
 *   - 组件里**不出现任何 invoke / 原生路径处理**，文件对话框一律走 lib/fs 封装，
 *     这样权限、错误结构、扩展名规则只有一处维护。
 *   - 所有按钮都有 `title`（含快捷键提示）。桌面端没有手机端的空间压力，
 *     图标按钮不带文字时，title 是唯一的可发现性来源，不能省。
 *   - 非 Tauri 环境（浏览器里做验收）对话框拿不到原生能力，明确给出提示而不是
 *     假装什么都没发生。
 */
import type { ReactNode } from "react";
import { useState } from "react";

import { isTauri } from "@tauri-apps/api/core";
import {
  Code2,
  FileDown,
  FilePlus2,
  FolderOpen,
  Monitor,
  Moon,
  Pencil,
  Save,
  SaveAll,
  Sun,
  X,
} from "lucide-react";

import { cycleThemeMode, useResolvedTheme, useThemeMode, type ThemeMode } from "@/hooks/useTheme";
import { cn, formatBytes } from "@/lib/utils";
import { exportHtmlFile } from "@/lib/export-html";
import { confirmDiscardIfDirty, fileName, pickMarkdownFile, pickSavePath } from "@/lib/fs";
import { useEditor, useIsDirty, type ViewMode } from "@/store/editor";

// ------------------------------------------------------------ 小构件

interface ToolButtonProps {
  label: string;
  /** 无障碍名称。与视觉 label 不一致时（例如三态主题）单独给一个更完整的描述。 */
  description?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function ToolButton({
  label,
  description,
  shortcut,
  disabled,
  onClick,
  children,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={description ?? label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-foreground/85",
        "transition-colors hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

/** 分隔竖线。桌面工具栏里比一条 border 更轻，也不会在换行时断得难看。 */
function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

/**
 * 视图模式两档。
 *
 * 原来的「仅编辑 / 分栏 / 仅预览」三档随左右分栏一起删掉了：
 * 实时预览本身就是「读」与「改」合一，再摆一个并排的预览面板只会压缩正文宽度。
 */
const VIEW_OPTIONS: ReadonlyArray<{ value: ViewMode; label: string; icon: typeof Pencil }> = [
  { value: "live", label: "实时预览", icon: Pencil },
  { value: "source", label: "源码", icon: Code2 },
];

const THEME_META: Record<ThemeMode, { label: string; icon: typeof Sun }> = {
  light: { label: "浅色", icon: Sun },
  dark: { label: "深色", icon: Moon },
  system: { label: "跟随系统", icon: Monitor },
};

// ------------------------------------------------------------ 主组件

export function Toolbar() {
  const path = useEditor((state) => state.path);
  const content = useEditor((state) => state.content);
  const viewMode = useEditor((state) => state.viewMode);
  const saving = useEditor((state) => state.saving);
  const setViewMode = useEditor((state) => state.setViewMode);
  const newDocument = useEditor((state) => state.newDocument);
  const open = useEditor((state) => state.open);
  const save = useEditor((state) => state.save);
  const saveAs = useEditor((state) => state.saveAs);
  const close = useEditor((state) => state.close);
  const setNotice = useEditor((state) => state.setNotice);
  const setError = useEditor((state) => state.setError);

  const dirty = useIsDirty();
  const themeMode = useThemeMode();
  const resolvedTheme = useResolvedTheme();

  /*
    「正在导出」放在组件本地状态而不是 store 里。

    store 里那个 `saving` 是必需的 —— 全局快捷键（Ctrl+S）和 App 的离开确认
    都要读它。导出只有工具栏这一个入口，没有第二个人需要知道，放进 store
    只会让这个本来就很长的 store 再多一个字段。
  */
  const [exporting, setExporting] = useState(false);

  const ThemeIcon = THEME_META[themeMode].icon;

  async function handleOpen(): Promise<void> {
    try {
      // 先取路径再问确认：用户取消对话框时不该被追问「要不要放弃改动」
      const picked = await pickMarkdownFile();
      if (!picked) {
        // 取消与「环境不支持」要分开说，否则用户会以为自己点错了
        if (!isTauri()) {
          setNotice("浏览器预览模式下没有原生文件对话框，请在桌面应用里使用");
        }
        return;
      }

      const decision = await confirmDiscardIfDirty(dirty, "打开其它文件");
      if (decision === "cancel") return;
      if (decision === "unsupported") {
        setNotice("当前文档有未保存的改动，请先保存（Ctrl+S）再打开其它文件");
        return;
      }

      await open(picked);
    } catch (err) {
      setError({
        code: "UNKNOWN",
        message: "打开文件失败",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSaveAs(): Promise<void> {
    try {
      const picked = await pickSavePath(path);
      if (!picked) {
        if (!isTauri()) {
          setNotice("浏览器预览模式下没有原生文件对话框，请在桌面应用里使用");
        }
        return;
      }
      await saveAs(picked);
    } catch (err) {
      setError({
        code: "UNKNOWN",
        message: "打开保存对话框失败",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 导出为独立 HTML。
   *
   * 这里**不过丢弃确认** —— 导出不改变当前文档，也不离开它，
   * 拿未保存的内容去导出恰恰是用户想要的（「先把现在这版导出去发人」）。
   */
  async function handleExportHtml(): Promise<void> {
    if (!content) {
      setNotice("当前文档是空的，没有可导出的内容");
      return;
    }
    setExporting(true);
    try {
      const outcome = await exportHtmlFile({
        markdown: content,
        title: path ? fileName(path).replace(/\.[^.]+$/, "") : "未命名文档",
        sourcePath: path,
        dark: resolvedTheme === "dark",
      });

      if (outcome.status === "cancelled") {
        // 取消与「环境不支持」要分开说，否则用户会以为自己点错了
        if (!isTauri()) {
          setNotice("浏览器预览模式下没有原生文件对话框，请在桌面应用里使用");
        }
        return;
      }
      setNotice(`已导出 ${fileName(outcome.path)}（${formatBytes(outcome.bytes)}）`);
    } catch (err) {
      setError({
        code: "UNKNOWN",
        message: "导出 HTML 失败",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setExporting(false);
    }
  }

  /** 新建 / 关闭共用：都是「离开当前文档」，都要过同一道丢弃确认 */  async function leaveCurrent(action: string, then: () => void): Promise<void> {
    try {
      const decision = await confirmDiscardIfDirty(dirty, action);
      if (decision === "cancel") return;
      if (decision === "unsupported") {
        setNotice(`当前文档有未保存的改动，请先保存（Ctrl+S）再${action}`);
        return;
      }
      then();
    } catch (err) {
      setError({
        code: "UNKNOWN",
        message: `${action}失败`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const title = path ? fileName(path) : "未命名文档";

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-toolbar-bg px-2 select-none">
      {/* ---- 文件名 ---- */}
      <div className="flex min-w-0 flex-1 items-baseline gap-2 pl-1">
        <span className="truncate text-sm font-medium text-foreground" title={path ?? undefined}>
          {title}
        </span>
        {dirty && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title="有未保存的改动"
            aria-label="有未保存的改动"
          >
            ●
          </span>
        )}
      </div>

      {/* ---- 文件操作 ---- */}
      <ToolButton label="新建" shortcut="Ctrl+N" onClick={() => void leaveCurrent("新建文档", newDocument)}>
        <FilePlus2 className="size-4" />
      </ToolButton>
      <ToolButton label="打开" shortcut="Ctrl+O" onClick={() => void handleOpen()}>
        <FolderOpen className="size-4" />
      </ToolButton>
      <ToolButton
        label={saving ? "保存中…" : "保存"}
        shortcut="Ctrl+S"
        disabled={saving || !path}
        onClick={() => void save()}
      >
        <Save className="size-4" />
      </ToolButton>
      <ToolButton
        label="另存为"
        shortcut="Ctrl+Shift+S"
        disabled={saving}
        onClick={() => void handleSaveAs()}
      >
        <SaveAll className="size-4" />
      </ToolButton>
      <ToolButton
        label={exporting ? "导出中…" : "导出 HTML"}
        description="导出为独立 HTML 文件，可直接分享"
        disabled={exporting || content.length === 0}
        onClick={() => void handleExportHtml()}
      >
        <FileDown className="size-4" />
      </ToolButton>
      <ToolButton
        label="关闭文档"
        disabled={!path}
        onClick={() => void leaveCurrent("关闭文档", close)}
      >
        <X className="size-4" />
      </ToolButton>

      <Divider />

      {/* ---- 视图模式 ---- */}
      <div
        role="group"
        aria-label="视图模式"
        className="flex items-center gap-0.5 rounded-md bg-muted p-0.5"
      >
        {VIEW_OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = viewMode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              title={`${option.label}（Ctrl+/ 切换）`}
              aria-label={option.label}
              aria-pressed={active}
              onClick={() => setViewMode(option.value)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded px-2 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{option.label}</span>
            </button>
          );
        })}
      </div>

      <Divider />

      {/* ---- 主题 ---- */}
      <ToolButton
        label={`主题：${THEME_META[themeMode].label}`}
        // 图标反映「实际生效」的主题，文字反映「用户选的三态」，
        // 两者在 system 下会不一致 —— 这正是需要更完整无障碍描述的原因。
        description={`主题：${THEME_META[themeMode].label}，当前显示为${
          resolvedTheme === "dark" ? "深色" : "浅色"
        }`}
        onClick={cycleThemeMode}
      >
        <ThemeIcon className="size-4" />
      </ToolButton>
    </header>
  );
}
