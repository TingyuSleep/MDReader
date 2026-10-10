/**
 * 批次 2 临时验收驱动器（用完即删）。
 *
 * 干三件事：
 *   1. 等 Vite dev server 起好
 *   2. 起一个 headless Chrome（独立临时 profile，绝不碰用户日常 profile）
 *   3. 用 CDP 打开 verify.html，轮询 document.title 直到出结果，再把 #out 文本抓回来
 *
 * 不用 playwright：Node 22 自带全局 WebSocket，直连 CDP 就够了，零安装。
 * 也不用 chrome --dump-dom：那个在 load 事件后就抓，等不到异步结果；
 * 加 --virtual-time-budget 又会把 performance.now() 变成虚拟时钟，性能数字就没意义了。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TARGET_URL = process.argv[2] ?? "http://localhost:1420/verify.html";
const DEBUG_PORT = Number(process.argv[3] ?? 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 探活：拿到任何 HTTP 响应就算服务器活着。
 *
 * 不能用 `res.ok` 判断 —— 验收构建没有 index.html，探根路径会拿到 404，
 * 那样会一直等到超时（踩过一次）。
 */
async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "无响应";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      lastStatus = String(res.status);
      if (res.status < 500) return;
    } catch (err) {
      lastStatus = err.cause?.message ?? err.message;
    }
    await sleep(300);
  }
  throw new Error(`等待超时：${label} (${url})，最后一次：${lastStatus}`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("exit", resolve);
  });
}

async function main() {
  await waitForHttp(TARGET_URL, 40000, "静态服务器");
  console.log(`[runner] 服务器就绪 ${new URL(TARGET_URL).origin}`);

  const profileDir = mkdtempSync(join(tmpdir(), "mdreader-verify-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,OptimizationHints",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let exitCode = 1;
  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 30000, "Chrome CDP");
    console.log("[runner] Chrome 就绪");

    const target = await (
      await fetch(
        `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(TARGET_URL)}`,
        { method: "PUT" },
      )
    ).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
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

    const evaluate = async (expression) => {
      const reply = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (reply.result?.exceptionDetails) {
        return `<eval error: ${reply.result.exceptionDetails.text}>`;
      }
      return reply.result?.result?.value;
    };

    await send("Runtime.enable");
    // 资源 404 之类只走 Log 域，不订阅就完全看不到
    await send("Log.enable");

    // 页面报错要能看见，否则只会拿到一句「title = localhost」无从下手
    const pageLog = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(" ");
        pageLog.push(`[console.${message.params.type}] ${text}`);
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        pageLog.push(`[exception] ${details?.exception?.description ?? details?.text}`);
      }
      if (message.method === "Log.entryAdded") {
        const entry = message.params.entry;
        pageLog.push(`[log.${entry.level}] ${entry.text} ${entry.url ?? ""}`);
      }
    });

    const deadline = Date.now() + 120000;
    let title = "";
    while (Date.now() < deadline) {
      title = await evaluate("document.title");
      if (typeof title === "string" && /^(ALL_PASS|HAS_FAILURES)/.test(title)) break;
      await sleep(400);
    }

    const output = await evaluate("document.getElementById('out')?.textContent ?? '<no #out>'");
    if (typeof output === "string" && output.startsWith("<no #out>")) {
      const debug = await evaluate(
        `(() => { try { return JSON.stringify({ steps: window.__verifySteps ?? [], waits: window.__verifyWaits ?? [], snapshot: window.__verifySnapshot ? window.__verifySnapshot() : null, hasCmEditor: !!document.querySelector('.cm-editor'), bodyChildren: document.body.children.length }); } catch (e) { return 'snapshot error: ' + e.message; } })()`,
      );
      console.log(`[runner] 未产出结果，页面状态：${debug}`);
    }

    console.log("\n================ 验收结果 ================");
    console.log(output);
    console.log("=========================================");
    console.log(`[runner] title = ${title}`);

    if (pageLog.length > 0) {
      console.log("\n---------------- 页面日志 ----------------");
      for (const line of pageLog.slice(-40)) console.log(line);
      console.log("-----------------------------------------");
    }

    exitCode = typeof title === "string" && title.startsWith("ALL_PASS") ? 0 : 1;
    ws.close();
  } catch (err) {
    console.error("[runner] 失败：", err.message);
  } finally {
    await killTree(chrome.pid);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // 临时 profile 删不掉不影响结论
    }
  }

  process.exit(exitCode);
}

await main();
