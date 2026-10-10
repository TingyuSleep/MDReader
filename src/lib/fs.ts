/**
 * 文件操作的唯一入口。
 *
 * 组件里不要直接出现 invoke / convertFileSrc / 原生路径处理，一律走这里，
 * 这样错误结构、路径规则、asset 白名单注册只有一处需要维护。
 */
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import {
  isAppError,
  type AppError,
  type FileContent,
  type SaveResult,
} from "@/types";

/** 支持的 Markdown 扩展名（小写，不含点） */
export const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

// ------------------------------------------------------------ 错误归一化

/** 把任何被抛出的东西压成 AppError，保证 UI 侧拿到的结构永远一致 */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (typeof err === "string") {
    return { code: "UNKNOWN", message: err, detail: null };
  }
  if (err instanceof Error) {
    return { code: "UNKNOWN", message: err.message, detail: null };
  }
  return { code: "UNKNOWN", message: "发生未知错误", detail: String(err) };
}

// ------------------------------------------------------------ 磁盘操作

/** 读取文件（不含 asset 白名单注册，纯读） */
export async function readFile(path: string): Promise<FileContent> {
  try {
    return await invoke<FileContent>("read_file", { path });
  } catch (err) {
    throw toAppError(err);
  }
}

/** 写入文件。返回 `written: false` 说明内容与磁盘一致，实际没落盘。 */
export async function writeFile(path: string, content: string): Promise<SaveResult> {
  try {
    return await invoke<SaveResult>("write_file", { path, content });
  } catch (err) {
    throw toAppError(err);
  }
}

/** 路径是否存在（查询类，失败按 false 处理） */
export async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return false;
  }
}

/** 把目录注册进 asset protocol 白名单，让本地图片能被 WebView 加载 */
export async function allowAssetDir(dir: string): Promise<void> {
  try {
    await invoke("allow_asset_dir", { dir });
  } catch (err) {
    // 图片加载失败不应该阻断文档打开，只告警
    console.warn("[fs] 注册图片访问目录失败", toAppError(err));
  }
}

/**
 * 打开文档：读内容 + 把所在目录加入 asset 白名单。
 * 两者绑在一起，避免调用方漏掉后者导致图片全挂。
 */
export async function openDocument(path: string): Promise<FileContent> {
  const file = await readFile(path);
  await allowAssetDir(dirName(file.path));
  return file;
}

// ------------------------------------------------------------ 原生文件对话框

/** 对话框过滤器，与 MARKDOWN_EXTENSIONS 保持单一来源 */
const DIALOG_FILTERS = [
  {
    name: "Markdown",
    // plugin-dialog 的 extensions 不带点
    extensions: MARKDOWN_EXTENSIONS.map((ext) => ext.replace(/^\./, "")),
  },
  { name: "所有文件", extensions: ["*"] },
];

/**
 * 弹原生「打开文件」框，返回绝对路径；用户取消返回 null。
 *
 * 非 Tauri 环境（纯浏览器跑 dev server 做验收）直接返回 null ——
 * 没有原生对话框可用，交给调用方给提示，不静默假装成功。
 */
export async function pickMarkdownFile(): Promise<string | null> {
  if (!isTauri()) return null;

  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: DIALOG_FILTERS,
  });

  // plugin-dialog 在多选关闭时返回 string | null
  if (typeof picked !== "string" || !picked) return null;
  return picked;
}

/**
 * 弹原生「另存为」框，返回目标绝对路径；用户取消返回 null。
 *
 * defaultPath 传当前文档路径，让对话框落在同目录、文件名也预填好。
 */
export async function pickSavePath(defaultPath?: string | null): Promise<string | null> {
  if (!isTauri()) return null;

  const picked = await saveDialog({
    filters: DIALOG_FILTERS,
    defaultPath: defaultPath ?? undefined,
  });

  if (typeof picked !== "string" || !picked) return null;

  // 用户只填了文件名（没扩展名）时补上 .md，否则下次打开不会被识别为 Markdown
  if (!isMarkdownFile(picked) && !/\.[a-z0-9]+$/i.test(picked)) {
    return `${picked}.md`;
  }
  return picked;
}

/** 导出 HTML 用的对话框过滤器 */
const EXPORT_FILTERS = [
  { name: "HTML 网页", extensions: ["html"] },
  { name: "所有文件", extensions: ["*"] },
];

/**
 * 弹原生「导出为 HTML」保存框，返回目标绝对路径；用户取消返回 null。
 *
 * 和 pickSavePath 分开而不是加参数复用，是因为两者的兜底补全规则不同：
 * 这里补 `.html`，那里补 `.md`。合成一个函数只会多出一堆条件分支。
 */
export async function pickExportHtmlPath(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null;

  const picked = await saveDialog({
    filters: EXPORT_FILTERS,
    defaultPath: defaultName,
  });

  if (typeof picked !== "string" || !picked) return null;

  // 用户把扩展名删掉时补回 .html，否则双击打开的是「未知文件类型」
  if (!/\.[a-z0-9]+$/i.test(picked)) return `${picked}.html`;
  return picked;
}

// ------------------------------------------------------------ 丢弃确认
/** 「有未保存改动」时询问的结果 */
export type DiscardDecision =
  /** 可以继续 */
  | "proceed"
  /** 用户主动取消 */
  | "cancel"
  /** 当前环境弹不出原生确认框（浏览器预览模式），调用方需要给出提示 */
  | "unsupported";

/**
 * 有未保存改动时弹原生确认框。
 *
 * 放在 fs.ts 而不是各调用点，是为了「所有会丢内容的入口共用同一套文案与语义」——
 * 新建 / 打开 / 关闭三处如果各写一遍，迟早出现某个入口忘了问。
 *
 * 没有改动时直接 proceed，不弹框（别让用户为一件不会丢数据的事点两次）。
 * 浏览器环境返回 unsupported 而不是 proceed：宁可挡一下也不能静默丢内容。
 */
export async function confirmDiscardIfDirty(
  dirty: boolean,
  action: string,
): Promise<DiscardDecision> {
  if (!dirty) return "proceed";
  if (!isTauri()) return "unsupported";

  try {
    const accepted = await ask(`当前文档有未保存的改动，确定要放弃这些改动并${action}吗？`, {
      title: "有未保存的改动",
      kind: "warning",
      okLabel: "放弃改动",
      cancelLabel: "取消",
    });
    return accepted ? "proceed" : "cancel";
  } catch (err) {
    console.warn("[fs] 确认框弹出失败", toAppError(err));
    // 弹不出来时按「不确定」处理，宁可挡一下
    return "unsupported";
  }
}

// ------------------------------------------------------------ 路径工具（纯字符串，不碰磁盘）

/** 取文件名（兼容 Windows 反斜杠） */
export function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** 取所在目录（兼容 Windows 反斜杠） */
export function dirName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

/** 是否为 Markdown 文件（用于拖拽/文件关联的过滤） */
export function isMarkdownFile(path: string): boolean {
  const name = fileName(path).toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** 本地绝对路径 → WebView 可加载的 asset:// URL */
export function toAssetUrl(absPath: string): string {
  return convertFileSrc(absPath);
}
