/**
 * 前后端共享的类型定义。
 *
 * 与 src-tauri/src/commands/file.rs 里的 serde 结构一一对应。
 * Rust 侧统一标注 #[serde(rename_all = "camelCase")]，所以这里按 camelCase 写。
 */

/** 文本编码。MVP 只区分 UTF-8 与 UTF-8 BOM，其余一律走 NOT_UTF8 报错。 */
export type TextEncoding = "utf-8" | "utf-8-bom";

/** 换行风格 */
export type EolStyle = "lf" | "crlf" | "cr";

/** read_file 的返回值 */
export interface FileContent {
  /** 解析后的绝对路径 */
  path: string;
  /** 原文，未做任何改写（已剥离 BOM） */
  content: string;
  encoding: TextEncoding;
  eol: EolStyle;
  /** 磁盘上的原始字节数（含 BOM） */
  size: number;
  /** 最后修改时间，Unix 毫秒；取不到为 null */
  modifiedMs: number | null;
  hasBom: boolean;
}

/** write_file 的返回值 */
export interface SaveResult {
  path: string;
  /** false 表示内容与磁盘完全一致，已跳过写入（时间戳保持不变） */
  written: boolean;
  size: number;
  modifiedMs: number | null;
}

/** 统一错误码 —— 前端据此决定提示文案，避免直接抛原始字符串 */
export type AppErrorCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "NOT_UTF8"
  | "IO"
  | "UNKNOWN";

// ------------------------------------------------------------ 渲染管线共享类型

/**
 * 目录项。
 *
 * 放在这里而不是 markdown-parse.ts：它是**跨线程**的数据形状 ——
 * Worker 解析时产出、主线程 store 持有、UI 消费。
 * 双方都用 `import type` 引它，编译后不留任何运行时代码，
 * 主线程因此不必为了这个类型去碰 markdown-parse 模块。
 */
export interface TocItem {
  /** 标题层级，1 = h1 */
  level: number;
  /** 标题纯文本（已剥离行内标记） */
  text: string;
  /** 锚点 id，同文档内保证唯一（重名会追加 -2 / -3…） */
  id: string;
}

/** Rust 侧 AppError 的镜像 */
export interface AppError {
  code: AppErrorCode;
  message: string;
  detail?: string | null;
}

/** 判断一个未知值是不是后端返回的 AppError */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AppError>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}
