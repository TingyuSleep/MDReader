/**
 * 界面截图工具（dev-only，用完即删）。
 *
 * 三套验收脚本都是断言型，验不了「看起来对不对」。这个脚本用 CDP 直连
 * 真实 Chrome，把欢迎页、实时预览、光标显形、查找面板、源码模式各截一张，用于肉眼过一遍。
 *
 * 和 verify-runner.mjs 一样：Node 22 自带全局 WebSocket，零安装。
 *
 * 用法：node dev/screenshot.mjs <baseUrl> <输出目录>
 *   baseUrl 指向 vite preview 的地址，页面是 /dev/preview-shell.html
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE_URL = process.argv[2] ?? "http://localhost:4174";
const OUT_DIR = process.argv[3] ?? "dev/shots";
const DEBUG_PORT = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  return new Promise((resolve) => {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("exit", resolve);
  });
}

/** 截图用的示例文档，覆盖标题/表格/任务列表/代码块/引用/图片/链接/删除线 */
const SAMPLE = `# MD阅读器

本地优先的 **Markdown** 编辑器，支持 \`GFM\` 语法与所见即所得编辑。

## 已实现的能力

- [x] 单栏所见即所得（Live Preview）
- [x] 查找替换（普通文本 + 正则）
- [x] 浅色 / 深色 / 跟随系统
- [ ] 导出 PDF（v3）

> 语法标记平时不显示，光标落到哪一段，哪一段就显形。

| 产物 | 体积 | 说明 |
| --- | --- | --- |
| 主线程 | 765 KB | React + CodeMirror |
| render.worker | 188 KB | markdown-it + highlight.js（已预留） |

\`\`\`ts
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\\s+/g, "-");
}
\`\`\`

删除线 ~~已废弃~~，图片 ![示意图](./img/demo.png)，自动链接 https://tauri.app
`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), "mdreader-shot-"));

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--window-size=1360,860",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // 还没起来，继续等
      }
      await sleep(300);
    }
    if (!ready) throw new Error("Chrome CDP 未就绪");

    const shellUrl = `${BASE_URL.replace(/\/$/, "")}/dev/preview-shell.html`;
    const target = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(shellUrl)}`, {
        method: "PUT",
      })
    ).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const pageLog = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        pageLog.push(`[exception] ${details?.exception?.description ?? details?.text}`);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        pageLog.push(
          `[console.error] ${(message.params.args ?? []).map((a) => a.value ?? a.description).join(" ")}`,
        );
      }
    });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1360,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evaluate = async (expression) => {
      const reply = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (reply.result?.exceptionDetails) {
        throw new Error(`eval 失败：${reply.result.exceptionDetails.text}`);
      }
      return reply.result?.result?.value;
    };

    const shoot = async (name) => {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const data = shot.result?.data;
      if (!data) throw new Error(`截图 ${name} 没有拿到数据`);
      const file = join(OUT_DIR, `${name}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${file}`);
    };

    const reload = async (theme, recent) => {
      await evaluate(
        `localStorage.setItem("md-reader.theme", ${JSON.stringify(theme)});` +
          `localStorage.setItem("md-reader.recent-files", ${JSON.stringify(JSON.stringify(recent))});`,
      );
      await send("Page.reload");
      await sleep(1400);
      // 等外壳暴露的 ready 标记
      for (let i = 0; i < 40 && !(await evaluate("window.__ready === true")); i += 1) {
        await sleep(100);
      }
    };

    const RECENT = [
      "D:/notes/周报-2026-Q3.md",
      "D:/code/AI_Code/MD阅读器/README.md",
      "C:/Users/52560/Documents/读书笔记.md",
    ];

    // ---- 1. 欢迎页 · 浅色
    await reload("light", RECENT);
    await shoot("01-welcome-light");

    // ---- 2. 欢迎页 · 深色
    await reload("dark", RECENT);
    await shoot("02-welcome-dark");

    /*
      光标默认落在位置 0（第一行），而块级标记是按行豁免的 —— 首行恰好是标题，
      `#` 会显形，截出来的图就看不出「标记被藏起来」这回事了。
      所以每次打开文档后都把光标挪到末尾的空行，让全篇处于「已渲染」的状态。
    */
    const endOfDoc = SAMPLE.length;

    // ---- 3. 实时预览主界面 · 浅色
    await reload("light", RECENT);
    await evaluate(`window.__openDemo(${JSON.stringify(SAMPLE)}, "D:/notes/MD阅读器示例.md");`);
    await sleep(1000);
    await evaluate(`window.__selectInEditor(${endOfDoc}, ${endOfDoc});`);
    await sleep(500);
    await shoot("03-live-light");

    // ---- 4. 实时预览 · 深色 + 未保存标记
    await evaluate(`localStorage.setItem("md-reader.theme","dark");`);
    await send("Page.reload");
    await sleep(1400);
    await evaluate(`window.__openDemo(${JSON.stringify(SAMPLE)}, "D:/notes/MD阅读器示例.md");`);
    await sleep(600);
    await evaluate(`window.__selectInEditor(${endOfDoc}, ${endOfDoc});`);
    await evaluate("window.__makeDirty();");
    await sleep(900);
    await shoot("04-live-dark-dirty");

    // ---- 5. 光标落进加粗文字 → 语法标记当场显形（实时预览的核心交互）
    const boldAt = SAMPLE.indexOf("**Markdown**") + 3;
    await evaluate(`window.__selectInEditor(${boldAt}, ${boldAt});`);
    await sleep(600);
    await shoot("05-live-cursor-marks");

    // ---- 6. 深色 + 查找替换面板
    await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));`);
    await sleep(250);
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="查找"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "阅读");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const toggle = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("显示替换"));
      toggle?.click();
    })()`);
    await sleep(500);
    await shoot("06-live-dark-find");

    // ---- 7. 源码模式 · 深色。同一个文档，标记全部回到原样
    await evaluate(`window.__setViewMode("source");`);
    await sleep(700);
    await shoot("07-source-dark");

    /*
      ---- 8/9. 拖选时的选区底色。

      选区曾经是**看不见**的：CM 把选区层的 z-index 写死成行内样式 -2，
      于是任何不透明的行级背景都会把它整块盖住 —— 受害最重的是「当前行高亮」，
      而那一行恰好是拖选时一直盯着的那一行。代码块底色同理。

      所以这里故意让选区从正文一路跨到代码块，并且光标（选区头）落在最后一行：
      一张图里同时出现「普通行」「代码块底色」「当前行高亮」三种背景，
      改坏了哪一处都能一眼看出来。
    */
    const selStart = SAMPLE.indexOf("本地优先的");
    const selEnd = SAMPLE.lastIndexOf("```") + 3;

    for (const theme of ["light", "dark"]) {
      await reload(theme, RECENT);
      await evaluate(`window.__openDemo(${JSON.stringify(SAMPLE)}, "D:/notes/MD阅读器示例.md");`);
      await sleep(900);
      await evaluate(`window.__selectInEditor(${selStart}, ${selEnd});`);
      await sleep(600);
      await shoot(`0${theme === "light" ? 8 : 9}-selection-${theme}`);
    }

    if (pageLog.length > 0) {
      console.log("\n---------------- 页面日志 ----------------");
      for (const line of pageLog.slice(-20)) console.log(line);
      console.log("-----------------------------------------");
    }

    console.log("[shot] 完成");
    ws.close();
  } catch (err) {
    console.error("[shot] 失败：", err.message);
    process.exitCode = 1;
  } finally {
    await killTree(chrome.pid);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 临时 profile 删不掉不影响结论
    }
  }
}

await main();
