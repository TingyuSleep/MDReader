/**
 * 主题状态。三态：浅色 / 深色 / 跟随系统。
 *
 * 实现要点：
 *   - 主题是**全局单例**而非组件局部状态。工具栏、编辑区、预览区看到的是同一份，
 *     所以用模块级变量 + `useSyncExternalStore` 订阅，不引入 Context、也不进 zustand
 *     （它是纯粹的表现层偏好，跟文档状态无关）。
 *   - `useSyncExternalStore` 的 getSnapshot **必须返回稳定值**，所以对外暴露的是两个
 *     字符串而不是对象 —— 每次返回新对象会导致无限重渲染。
 *   - 真正切 class 的是 `document.documentElement`，配合 index.css 里的
 *     `@custom-variant dark (&:is(.dark *))`，所有令牌一次性翻转，无需 JS 参与配色。
 *   - 首屏防闪白靠 public/theme-init.js，它读的是同一个 storage key。
 *
 * 为什么不用 `mode === "dark"` 直接判断：跟随系统时用户改系统设置要能立刻生效，
 * 所以 resolved 值需要单独派生并订阅 matchMedia。
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** ⚠ 与 public/theme-init.js 里的键必须一致 */
const STORAGE_KEY = "md-reader.theme";

// ------------------------------------------------------------ 纯逻辑（可单独测试）

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/** 读存储的偏好。读不到或值非法一律回落到 system。 */
function readStoredMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    // 存不下不影响本次会话，只告警
    console.warn("[theme] 保存主题偏好失败", err);
  }
}

/** 系统当前是否偏好深色 */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return systemPrefersDark() ? "dark" : "light";
}

/** 三态循环：跟系统 → 浅色 → 深色 → 跟系统…… */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "system") return "light";
  if (mode === "light") return "dark";
  return "system";
}

// ------------------------------------------------------------ 单例状态

let currentMode: ThemeMode = typeof window === "undefined" ? "system" : readStoredMode();
let currentResolved: ResolvedTheme = resolveTheme(currentMode);

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 把当前模式落到 DOM 上。只改一个 class，配色全部由 CSS 变量接管。 */
function applyToDom(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", currentResolved === "dark");
}

/** 重算 resolved 并按需刷新 DOM 与订阅者 */
function refresh(): void {
  const resolved = resolveTheme(currentMode);
  const changed = resolved !== currentResolved;
  currentResolved = resolved;
  applyToDom();
  if (changed) emit();
}

// 模块加载即同步一次，保证 theme-init.js 未生效时（例如 localStorage 被清）也不会脱节
applyToDom();

// 跟随系统时，系统切换要立刻反映到界面上
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    if (currentMode === "system") refresh();
  };
  // Safari 14 之前只有 addListener。Tauri 用的 WebView2/WebKit 都支持 addEventListener，
  // 这里只做兜底判断，不额外维护两条路径。
  if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
}

// ------------------------------------------------------------ 对外 API

export function getThemeMode(): ThemeMode {
  return currentMode;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

export function setThemeMode(mode: ThemeMode): void {
  if (currentMode === mode) return;
  currentMode = mode;
  writeStoredMode(mode);
  refresh();
  emit();
}

/** 三态循环一步 */
export function cycleThemeMode(): void {
  setThemeMode(nextThemeMode(currentMode));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前模式（"light" | "dark" | "system"） */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, getThemeMode);
}

/** 实际生效的主题（把 system 解析成 light / dark） */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, getResolvedTheme);
}
