import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Web Worker 以 ESM 方式构建（渲染管线跑在 worker 里）
  worker: {
    format: "es",
  },

  // 只暴露 VITE_ 与 TAURI_ENV_ 前缀的环境变量给前端
  envPrefix: ["VITE_", "TAURI_ENV_"],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // 目标运行时是 WebView2（Chromium），不需要为老浏览器降级
    target: "chrome105",
    // 离线优先：不做 CDN 外链，全部打包
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1500,
  },
}));
