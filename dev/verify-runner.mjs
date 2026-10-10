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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    /*
      ---- 打印套件专用：打印媒体探针 + 真实 PDF

      页面自己改不了媒体类型（`Emulation.setEmulatedMedia` 是 CDP 域的能力），
      所以"打印媒体下外壳到底有没有被藏住、正文是不是真的排上了版"这层
      只能由这里配合验。页面检测到就做，其它套件完全不受影响。

      顺带把打印媒体下的版面抓成 PDF 存进 docs/samples/ —— 断言只能证明"符合预期"，
      证明不了"看起来对"，这两件事互补，和导出那套（make-sample-export.mjs）一个道理。
    */
    const extraLines = [];
    let extraFail = 0;
    const linesBeforeProbe = typeof output === "string" ? output.split("\n").length : 0;

    const hasProbe = await evaluate("typeof window.__printMediaProbe === 'function'");
    if (hasProbe === true) {
      console.log("[runner] 检测到打印媒体探针，切到 print 媒体再跑一轮");

      await send("Emulation.setEmulatedMedia", { media: "print" });
      const probed = await evaluate("window.__printMediaProbe()");

      if (Array.isArray(probed)) {
        probed.forEach((item, index) => {
          if (!item.pass) extraFail += 1;
          extraLines.push(
            `${item.pass ? "PASS" : "FAIL"} P${String(index + 1).padStart(2, "0")} ${item.name}${item.info ? ` | ${item.info}` : ""}`,
          );
        });
      } else {
        extraFail += 1;
        extraLines.push(`FAIL P?? 打印媒体探针没有返回结果 | ${JSON.stringify(probed)}`);
      }

      // 抓一份真实 PDF。纸张与页边距在这里再传一遍：CDP 的参数会盖掉 CSS 的 @page，
      // 之所以还在 CSS 里保留 @page，是为了护住 WebView2 里那条交互打印路径。
      await send("Page.enable");
      const pdfReply = await send("Page.printToPDF", {
        printBackground: true,
        paperWidth: 8.27,
        paperHeight: 11.69,
        marginTop: 0.63,
        marginBottom: 0.63,
        marginLeft: 0.59,
        marginRight: 0.59,
      });

      const base64 = pdfReply?.result?.data;
      if (typeof base64 === "string" && base64.length > 0) {
        const buffer = Buffer.from(base64, "base64");
        const pdfPath = join(process.cwd(), "docs", "samples", "打印样例.pdf");
        mkdirSync(join(process.cwd(), "docs", "samples"), { recursive: true });
        writeFileSync(pdfPath, buffer);

        // 页数从 PDF 对象里数：/Type /Page（不能把 /Type /Pages 也算进去）
        const pageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
        const checks = [
          ["产出的 PDF 是合法 PDF（%PDF- 头）", buffer.subarray(0, 5).toString("latin1") === "%PDF-", buffer.subarray(0, 8).toString("latin1")],
          ["PDF 有内容（> 8 KB，不是空白页）", buffer.length > 8192, `${(buffer.length / 1024).toFixed(1)} KB`],
          ["PDF 至少两页（样例够长，分页规则才有意义）", pageCount >= 2, `${pageCount} 页`],
        ];
        for (const [name, pass, info] of checks) {
          if (!pass) extraFail += 1;
          extraLines.push(`${pass ? "PASS" : "FAIL"} P${String(extraLines.length + 1).padStart(2, "0")} ${name}${info ? ` | ${info}` : ""}`);
        }
        console.log(`[runner] 打印样例已落盘 ${pdfPath}（${(buffer.length / 1024).toFixed(1)} KB，${pageCount} 页）`);
      } else {
        extraFail += 1;
        extraLines.push("FAIL P?? Page.printToPDF 没有返回数据");
      }

      await send("Emulation.setEmulatedMedia", { media: "" });
      const cleaned = await evaluate("window.__printMediaCleanup()");
      const cleanPass = cleaned === true;
      if (!cleanPass) extraFail += 1;
      extraLines.push(`${cleanPass ? "PASS" : "FAIL"} P${String(extraLines.length + 1).padStart(2, "0")} 探针的打印容器已清理`);

      console.log("\n---------- 打印媒体探针（CDP Emulation） ----------");
      for (const line of extraLines) console.log(line);
      console.log(`---------- 探针小结：${extraLines.length - extraFail} 通过 / ${extraFail} 失败 ----------`);
      console.log(`[runner] 页面内 ${linesBeforeProbe} 行 + 探针 ${extraLines.length} 行`);
    }

    if (pageLog.length > 0) {
      console.log("\n---------------- 页面日志 ----------------");
      for (const line of pageLog.slice(-40)) console.log(line);
      console.log("-----------------------------------------");
    }

    exitCode = typeof title === "string" && title.startsWith("ALL_PASS") && extraFail === 0 ? 0 : 1;
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
