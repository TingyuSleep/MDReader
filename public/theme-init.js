/*
 * 主题初始化。
 *
 * 在 CSS 与 React 之前执行，避免深色模式用户看到一帧白屏（FOUC）。
 *
 * 为什么是独立的 js 文件而不是 <head> 里的内联脚本：
 *   tauri.conf.json 的 CSP 里 script-src 只有 'self'，内联脚本会被直接拦掉。
 *   同源外链是唯一干净的做法。
 *
 * ⚠ 这里的存储键必须与 src/hooks/useTheme.ts 里的 STORAGE_KEY 保持一致。
 * ⚠ 不用 ES6+ 语法，保证任何构建/压缩环节都不会干扰它。
 */
(function () {
  try {
    var mode = window.localStorage.getItem("md-reader.theme");
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = mode === "dark" || (mode !== "light" && prefersDark);
    if (dark) {
      document.documentElement.classList.add("dark");
    }
  } catch (e) {
    // localStorage / matchMedia 不可用时保持浅色即可。
    // 主题偏好丢了无所谓，但不能因为主题逻辑出错让页面白屏。
  }
})();
