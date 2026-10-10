/**
 * 生成一份**真实的**导出样例，落到 docs/samples/ 下供人眼查看。
 *
 * 为什么要单独跑一遍而不复用验收脚本：
 *   验收脚本判的是「符合预期」（字符串、计算样式），样例判的是「看起来对」。
 *   两者互补。把同一段 Markdown 走一遍真管线、把成品写成文件，
 *   是唯一能回答「导出之后到底长什么样」的办法。
 *
 * 用法（需要先起好 dist-verify 的静态服务器）：
 *   node dev/make-sample-export.mjs http://127.0.0.1:4173/dev/verify-export.html
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TARGET_URL = process.argv[2] ?? "http://127.0.0.1:4173/dev/verify-export.html";
const DEBUG_PORT = Number(process.argv[3] ?? 9344);
const OUT_DIR = resolve("docs/samples");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE = `# MD阅读器 · 导出样例

> 这段文字是从 Markdown 渲染出来的。导出物是**单个自包含的 HTML 文件** ——
> 双击就能在任何浏览器里打开，不需要联网，也不依赖任何外部资源。

## 排版

正文支持 **加粗**、*斜体*、~~删除线~~、\`行内代码\`，以及[外部链接](https://example.com)。

引用块：

> 衡门之下，可以栖迟。
> 泌之洋洋，可以乐饥。

### 列表

- 无序列表第一项
- 第二项
  - 嵌套一层
- 第三项

1. 有序列表第一项
2. 第二项

任务列表：

- [x] 单栏所见即所得
- [x] 查找替换
- [x] 底部状态栏
- [ ] 导出 PDF

### 表格

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 实时预览 | 已完成 | 标记藏在编辑区里就地渲染 |
| 导出 HTML | 已完成 | 样式从当前样式表按选择器提取后内联 |
| 多标签页 | 未开始 | —— |

### 代码

\`\`\`ts
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\\p{L}\\p{N}\\s-]/gu, "")
    .replace(/\\s+/g, "-");
}
\`\`\`

\`\`\`python
def count_words(text: str) -> int:
    """中日韩逐字 + 西文按词"""
    return len([c for c in text if c.strip()])
\`\`\`

---

导出时间见正文顶部；样式与编辑时的实时预览一致，深浅主题各自独立。
`;

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // 还没起来
    }
    await sleep(300);
  }
  throw new Error(`等待超时：${label}`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("exit", resolve);
  });
}

async function main() {
  await waitForHttp(TARGET_URL, 40000, "静态服务器");

  const profileDir = mkdtempSync(join(tmpdir(), "mdreader-sample-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 30000, "Chrome CDP");

    const target = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(TARGET_URL)}`, {
        method: "PUT",
      })
    ).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP 连接失败")), { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      const r = pending.get(m.id);
      if (r) {
        pending.delete(m.id);
        r(m);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const reply = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (reply.result?.exceptionDetails) {
        throw new Error(reply.result.exceptionDetails.text);
      }
      return reply.result?.result?.value;
    };

    await send("Runtime.enable");

    // 等模块求值完，出口挂上 window
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("typeof window.__sampleExport === 'function'")) break;
      await sleep(200);
    }

    mkdirSync(OUT_DIR, { recursive: true });

    for (const [dark, name] of [
      [false, "导出样例-浅色.html"],
      [true, "导出样例-深色.html"],
    ]) {
      const html = await evaluate(
        `window.__sampleExport(${JSON.stringify(SAMPLE)}, ${dark})`,
      );
      if (typeof html !== "string" || !html.startsWith("<!doctype html>")) {
        throw new Error(`生成失败（dark=${dark}）：${String(html).slice(0, 200)}`);
      }
      const file = join(OUT_DIR, name);
      writeFileSync(file, html, "utf8");
      console.log(`${name}  ${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KB`);
    }

    ws.close();
  } finally {
    await killTree(chrome.pid);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 临时 profile 删不掉不影响结果
    }
  }
}

await main();
