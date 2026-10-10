/**
 * 验收构建配置（dev-only，不参与正式打包）。
 *
 * 为什么不走 `vite dev`：
 *   1. Vite 依赖预构建提交阶段要删 node_modules/.vite/deps_temp_*（75 个文件），
 *      会被 WorkBuddy 的批量删除保护拦下，**整个 dev server 直接崩溃**。
 *   2. 生产构建顺带把「Worker 能不能正确切成独立 chunk」这件事一起验了 ——
 *      这个用 dev server 是验不出来的。
 *
 * 用法：corepack pnpm exec vite build   --config vite.verify.config.ts
 *       corepack pnpm exec vite preview --config vite.verify.config.ts --port 4173
 *       node dev/verify-runner.mjs http://localhost:4173/dev/verify-editor.html
 *
 * 放在项目根目录而不是 dev/ 下，是为了和 vite.config.ts 同属 tsconfig.node.json
 * 那个 project，避免跨 project 引用报 TS6305。
 */
import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig, type ConfigEnv } from "vite";

import baseConfig from "./vite.config";

const base = typeof baseConfig === "function" ? baseConfig({} as ConfigEnv) : baseConfig;

export default defineConfig(
  mergeConfig(base, {
    build: {
      outDir: "dist-verify",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          "verify-render": fileURLToPath(new URL("./dev/verify.html", import.meta.url)),
          "verify-editor": fileURLToPath(new URL("./dev/verify-editor.html", import.meta.url)),
          "verify-app": fileURLToPath(new URL("./dev/verify-app.html", import.meta.url)),
          "verify-status": fileURLToPath(new URL("./dev/verify-status.html", import.meta.url)),
          "verify-export": fileURLToPath(new URL("./dev/verify-export.html", import.meta.url)),
          "verify-print": fileURLToPath(new URL("./dev/verify-print.html", import.meta.url)),
          "preview-shell": fileURLToPath(new URL("./dev/preview-shell.html", import.meta.url)),
        },
      },
    },
  }),
);
