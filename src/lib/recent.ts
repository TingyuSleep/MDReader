/**
 * 最近文件列表的本地持久化。
 *
 * 存在 localStorage 里 —— WebView 自带、重启后仍在，不需要后端参与。
 *
 * 三条防御性设计：
 *   1. **任何 localStorage 访问都包 try**。隐私模式、磁盘配额、企业策略都可能让它
 *      直接抛异常。最近文件丢了不是致命问题，但绝不能因此让整个应用起不来。
 *   2. **反序列化失败一律当空列表**，不做「部分修复」。修一个坏 JSON 只会把坏数据
 *      继续传下去，不如干净重来。
 *   3. **读回来的数据要重新校验**。localStorage 是明文，用户能手工改，
 *      所以去重、剔除非字符串、限长这些事在读的时候再做一遍。
 */

const STORAGE_KEY = "md-reader.recent-files";

/** 最近文件上限。太多会把欢迎页撑爆，10 个正好一屏。 */
export const MAX_RECENT_FILES = 10;

/** 归一化：只留非空字符串、去重、截断到上限 */
function normalize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_RECENT_FILES) break;
  }

  return result;
}

/** 读取最近文件。任何异常都降级为空数组。 */
export function loadRecentFiles(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch (err) {
    console.warn("[recent] 读取最近文件失败，按空列表处理", err);
    return [];
  }
}

/** 写入最近文件。失败只告警，不影响主流程。 */
export function saveRecentFiles(paths: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(paths)));
  } catch (err) {
    console.warn("[recent] 保存最近文件失败", err);
  }
}

/** 把一条路径插到队首，去重并截断。纯函数，返回新数组。 */
export function pushRecentFile(current: readonly string[], filePath: string): string[] {
  const trimmed = filePath.trim();
  if (!trimmed) return normalize(current);
  return normalize([trimmed, ...current.filter((p) => p !== trimmed)]);
}

/** 从列表中移除一条路径。纯函数，返回新数组。 */
export function dropRecentFile(current: readonly string[], filePath: string): string[] {
  return current.filter((p) => p !== filePath);
}
