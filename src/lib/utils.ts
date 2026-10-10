import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind class，后者覆盖前者的同类属性（shadcn/ui 约定） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 字节数 → 人类可读。
 *
 * 放在这里而不是各组件里各写一遍：文档大小提示在预览面板（超限提示）和
 * 导出结果提示里都要用，两处口径不一致会让人以为哪里出了问题。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
