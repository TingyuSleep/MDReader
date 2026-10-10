/**
 * 验收套件 · 选区（**常驻**，不要当临时探针删掉）。分两段：
 *
 * 【第一段】鼠标拖选能不能选准 —— 必须用 CDP 派发**真实**鼠标事件。
 *   CodeMirror 的拖选依赖 pointerdown / pointermove / setPointerCapture 和实时 DOM 布局，
 *   而 Live Preview 的装饰层每时每刻都在改 DOM。两者一旦打架，症状是「拖选选不准」，
 *   但这在页面内写断言是测不出来的 —— 页面里 `dispatchEvent(new MouseEvent("mousedown"))`
 *   根本不会触发 pointer 事件链，测出来永远是假象。这就是它单独成一个文件的原因。
 *
 * 【第二段】选区**看不看得见** —— 必须比真实像素。
 *   ⚠ 这里踩过一个很贵的坑：最初只断言
 *   `getComputedStyle(.cm-selectionBackground).backgroundColor !== CM 默认色`，
 *   结果**假通过**了 —— 计算色值完全正确，人眼却什么都看不到。
 *   因为色值 ≠ 可见性：一个元素可以是正确的颜色、正确的位置、opacity 1，
 *   却整个被上层的不透明背景盖住。
 *   所以这一段一律截图 + 读像素，在**同一行内**比较「选区内」和「选区外」两点的颜色。
 *   同一行是刻意的 —— 排除了行背景本身（当前行高亮、代码块底色）带来的干扰。
 *
 * 用法：node dev/verify-selection.mjs <baseUrl> [debugPort]
 *   baseUrl 指向 vite preview 的地址
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE_URL = process.argv[2] ?? "http://127.0.0.1:4173";
const DEBUG_PORT = Number(process.argv[3] ?? 9337);

/** 同一行内「选区内 vs 选区外」的通道差下限。实测正常能到 45~115，被盖住时接近 0。 */
const MIN_SELECTION_DELTA = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 位置全部可预测，方便断言拖到了第几个字符 */
const DOC = [
  "第一行普通文字，用来测试拖选。",
  "第二行有 **加粗** 和 *斜体* 混排。",
  "第三行结束。",
].join("\n");

/**
 * 可见性用的文档。每一行都刻意留了「后半段不选中」的部分，好做同行对照。
 * 第 2 行普通正文、第 5 行在代码块里（会被代码块底色盖住）、第 8 行用来验「非当前行」。
 */
const VIS_DOC = [
  "# 标题行",
  "",
  "正文 **加粗** 与 `代码` 混排，后半段留作对照。",
  "",
  "```ts",
  "const answer = 42; // 后半段不选中",
  "```",
  "",
  "普通行一，后半段留作对照。",
  "普通行二，这里放光标。",
  "普通行三，未选中作对照。",
].join("\n");

/** 每一行在文档里的起始位置 */
const LINE_STARTS = (() => {
  const starts = [];
  let pos = 0;
  for (const line of VIS_DOC.split("\n")) {
    starts.push(pos);
    pos += line.length + 1;
  }
  return starts;
})();

let passCount = 0;
let failCount = 0;

function check(label, ok, info = "") {
  if (ok) passCount += 1;
  else failCount += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${info ? ` | ${info}` : ""}`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("exit", resolve);
  });
}

async function main() {
  const profileDir = mkdtempSync(join(tmpdir(), "mdreader-sel-"));
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
        // 还没起来
      }
      await sleep(300);
    }
    if (!ready) throw new Error("Chrome CDP 未就绪");

    const url = `${BASE_URL.replace(/\/$/, "")}/dev/preview-shell.html`;
    const target = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, {
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
      const failure = reply.result?.exceptionDetails;
      if (failure) {
        // `text` 恒为 "Uncaught"，真正的原因只在 exception.description 里
        const detail = failure.exception?.description ?? failure.text ?? "(无详情)";
        throw new Error(`eval 失败：${detail}\n  表达式：${expression.slice(0, 120)}`);
      }
      return reply.result?.result?.value;
    };

    for (let i = 0; i < 60 && !(await evaluate("window.__ready === true")); i += 1) {
      await sleep(100);
    }

    /** 真实鼠标拖选：按下 → 分步移动 → 抬起 */
    const dragSelect = async (fromPos, toPos, steps = 6) => {
      const start = JSON.parse(await evaluate(`JSON.stringify(window.__coordsAt(${fromPos}))`));
      const end = JSON.parse(await evaluate(`JSON.stringify(window.__coordsAt(${toPos}))`));
      if (!start || !end) throw new Error(`拿不到坐标：${fromPos} → ${toPos}`);

      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: start.x,
        y: start.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (let i = 1; i <= steps; i += 1) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.x + ((end.x - start.x) * i) / steps,
          y: start.y + ((end.y - start.y) * i) / steps,
          button: "left",
          buttons: 1,
        });
        await sleep(25);
      }
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: end.x,
        y: end.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await sleep(200);

      return JSON.parse(await evaluate("JSON.stringify(window.__getSelection())"));
    };

    /** 拖选前的准备：重置光标、可选切模式 */
    const prepare = async (viewMode) => {
      if (viewMode) {
        await evaluate(`window.__setViewMode(${JSON.stringify(viewMode)});`);
        await sleep(400);
      }
      await evaluate(`window.__openDemo(${JSON.stringify(DOC)}, "D:/notes/probe.md");`);
      await sleep(700);
      await evaluate("window.__selectInEditor(0, 0);");
      await sleep(250);
    };

    const reportDrag = (label, got, expectFrom, expectTo) => {
      const len = got ? got.to - got.from : -1;
      const expectLen = expectTo - expectFrom;
      // 允许一个字符的取整误差（坐标 ↔ 位置换算难免差半个字符宽）
      check(
        label,
        Math.abs(len - expectLen) <= 1,
        `期望长度 ${expectLen} 实得 ${len} (from=${got?.from} to=${got?.to})`,
      );
    };

    console.log("================ 鼠标拖选验收 ================");

    // ---- 基线：源码模式。这里没有任何装饰，它要是也选不中，问题就不在装饰层。
    await prepare("source");
    reportDrag("源码模式 · 同一行内拖选", await dragSelect(0, 5), 0, 5);
    await evaluate("window.__selectInEditor(0, 0);");
    await sleep(200);
    const crossSource = await dragSelect(0, DOC.indexOf("第三行") + 2);
    reportDrag("源码模式 · 跨行拖选", crossSource, 0, DOC.indexOf("第三行") + 2);

    // ---- 实时预览模式
    await prepare("live");
    await evaluate("window.__selectInEditor(0, 0);");
    await sleep(250);
    reportDrag("实时预览 · 同一行内拖选", await dragSelect(0, 5), 0, 5);

    await evaluate("window.__selectInEditor(0, 0);");
    await sleep(250);
    const crossLive = await dragSelect(0, DOC.indexOf("第三行") + 2);
    reportDrag("实时预览 · 跨行拖选", crossLive, 0, DOC.indexOf("第三行") + 2);

    /*
      最关键的一条：跨越 `**加粗**` 拖选。

      这里没有冻结装饰的话，拖动时选区扫过 `**加粗**`，豁免规则会让 `**` 当场显形，
      那一行多出 4 个字符宽，后面所有文字的横坐标整体右移 ——
      CM 是按坐标反算位置的，于是选区终点自己往回缩。
      回归前实测：期望 11 个字符，实际只选到 8 个。
    */
    const boldStart = DOC.indexOf("**加粗**");
    await evaluate("window.__selectInEditor(0, 0);");
    await sleep(250);
    reportDrag(
      "实时预览 · 跨越 **加粗** 拖选",
      await dragSelect(boldStart - 3, boldStart + 8),
      boldStart - 3,
      boldStart + 8,
    );

    // ---- 拖选松手后，装饰必须恢复工作，不能一直冻着
    await evaluate("window.__selectInEditor(0, 0);");
    await sleep(300);
    const stillFrozen = await evaluate(
      `(document.querySelector(".cm-content")?.textContent ?? "").includes("**加粗**")`,
    );
    check("松手后装饰恢复（光标移开后 ** 重新隐藏）", stillFrozen === false, `仍可见=${stillFrozen}`);

    // ================================================================
    // 第二段：选区看不看得见（真实像素）
    // ================================================================

    /**
     * 读截图里若干点的实际颜色。
     *
     * 把截图的 base64 当成 data: URL 塞回页面，交给浏览器自己解码 + canvas 取像素 ——
     * 比自己写 PNG 解码器可靠（手写的那版蓝通道是错的，近白色会解成偏黄）。
     * CSP 的 img-src 里有 data:，canvas 读 data: 图不会被污染。
     */
    const samplePixels = async (points) => {
      const reply = await send("Page.captureScreenshot", { format: "png" });
      const dataUrl = `data:image/png;base64,${reply.result.data}`;
      const raw = await evaluate(
        "(async () => {" +
          `const img = new Image(); img.src = ${JSON.stringify(dataUrl)};` +
          "await img.decode();" +
          "const canvas = document.createElement('canvas');" +
          "canvas.width = img.width; canvas.height = img.height;" +
          "const ctx = canvas.getContext('2d');" +
          "ctx.drawImage(img, 0, 0);" +
          `const points = ${JSON.stringify(points)};` +
          "const out = {};" +
          "for (const name of Object.keys(points)) {" +
          "  const p = points[name];" +
          "  const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;" +
          "  out[name] = [d[0], d[1], d[2]];" +
          "}" +
          "return JSON.stringify({ size: [img.width, img.height], out });" +
          "})()",
      );
      return { ...JSON.parse(raw), dataUrl };
    };

    const colorOf = (px) => `rgb(${px[0]} ${px[1]} ${px[2]})`;
    const deltaOf = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

    /**
     * 在一个主题下，跑三组「同一行内 选区内 vs 选区外」的对照。
     *
     * `cases` 里给的是**文档偏移**，坐标由 `__coordsAt` 换算，不写死像素。
     */
    const inspectVisibility = async (theme, cases) => {
      await evaluate(`window.__setTheme(${JSON.stringify(theme)});`);
      await sleep(250);
      await evaluate(`window.__setViewMode("live");`);
      await sleep(400);
      await evaluate(`window.__openDemo(${JSON.stringify(VIS_DOC)}, "D:/notes/selection.md");`);
      await sleep(700);

      for (const item of cases) {
        await evaluate(`window.__selectInEditor(${item.sel[0]}, ${item.sel[1]});`);
        await sleep(450);

        const points = {};
        for (const [name, pos] of Object.entries(item.probe)) {
          const coords = JSON.parse(await evaluate(`JSON.stringify(window.__coordsAt(${pos}))`));
          if (!coords) throw new Error(`拿不到坐标 ${name}@${pos}`);
          points[name] = coords;
        }
        const shot = await samplePixels(points);
        const a = shot.out.inside;
        const b = shot.out.outside;
        const delta = deltaOf(a, b);

        // 存一张图，改样式之后想肉眼复核时直接看
        mkdirSync("dev/shots-probe", { recursive: true });
        const file = `dev/shots-probe/selection-${theme}-${item.id}.png`;
        writeFileSync(file, Buffer.from(shot.dataUrl.split(",")[1], "base64"));

        check(
          `${theme === "light" ? "浅色" : "深色"} · ${item.label}`,
          delta >= MIN_SELECTION_DELTA,
          `选区内 ${colorOf(a)} vs 同行的选区外 ${colorOf(b)}，通道差 ${delta}（下限 ${MIN_SELECTION_DELTA}）`,
        );
        const head = await evaluate("JSON.stringify(window.__getSelection())");
        if (JSON.parse(head).empty) {
          check(`  ↳ ${item.label} 的选区没建立起来`, false, head);
        }

        // 选区颜色必须是半透明的：抬到正文之上后，不透明就会把字糊掉。
        // 注意计算值不一定长成 rgb()/rgba() —— 现代语法会返回
        // `lab(55.1124 -4.33156 -53.7148 / 0.45)`，透明度写在斜杠后面。
        if (item.checkAlpha) {
          const alpha = String(
            await evaluate(
              `getComputedStyle(document.querySelector(".cm-selectionBackground")).backgroundColor`,
            ),
          );
          const hasAlpha = alpha.startsWith("rgba(") || alpha.includes("/");
          check("  ↳ 选区色带 alpha（否则会盖住文字）", hasAlpha, alpha);
        }
      }
    };

    const VIS_CASES = [
      {
        id: "active-line",
        label: "光标所在行的选区看得见（当前行高亮曾把它盖住）",
        sel: [LINE_STARTS[2], LINE_STARTS[2] + 12],
        probe: { inside: LINE_STARTS[2] + 4, outside: LINE_STARTS[2] + 18 },
        checkAlpha: true,
      },
      {
        id: "code-block",
        label: "代码块行上的选区看得见（代码块底色曾把它盖住）",
        sel: [LINE_STARTS[5], LINE_STARTS[5] + 14],
        probe: { inside: LINE_STARTS[5] + 4, outside: LINE_STARTS[5] + 22 },
      },
      {
        id: "non-active",
        label: "非当前行的选区看得见",
        sel: [LINE_STARTS[8], LINE_STARTS[9]],
        probe: { inside: LINE_STARTS[8] + 4, outside: LINE_STARTS[10] + 4 },
      },
    ];

    await inspectVisibility("light", VIS_CASES);
    await inspectVisibility("dark", VIS_CASES);

    // ---- 层叠顺序。像素测试能证明「现在看得见」，这里证明「靠什么看得见」，
    //      顺便盯住 CodeMirror 的行内 z-index 有没有变（它是 !important 压下去的）。
    const zIndexOf = async (selector) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
                  return el ? getComputedStyle(el).zIndex : null; })()`,
      );

    await evaluate(`window.__setViewMode("live");`);
    await sleep(500);
    await evaluate("window.__selectInEditor(0, 4);");
    await sleep(400);

    const zSelectionLive = Number(await zIndexOf(".cm-selectionLayer"));
    const zCursor = Number(await zIndexOf(".cm-cursorLayer"));
    check(
      "选区层被抬到正文之上（压过 CM 写死的行内 z-index: -2）",
      Number.isFinite(zSelectionLive) && zSelectionLive >= 1,
      `z-index=${zSelectionLive}（CM 行内写的是 -2，必须 !important 才压得住）`,
    );
    check(
      "光标层仍在选区之上（选区不会挡住光标）",
      Number.isFinite(zCursor) && zCursor > zSelectionLive,
      `光标=${zCursor} 选区=${zSelectionLive}`,
    );

    await evaluate(`window.__setViewMode("source");`);
    await sleep(500);
    await evaluate("window.__selectInEditor(0, 4);");
    await sleep(400);
    const zGutters = Number(await zIndexOf(".cm-gutters"));
    check(
      "源码模式下行号栏仍在选区之上（选区不会盖住行号）",
      Number.isFinite(zGutters) && zGutters > Number(await zIndexOf(".cm-selectionLayer")),
      `行号栏=${zGutters} 选区=${await zIndexOf(".cm-selectionLayer")}`,
    );

    // ---- 端到端：用户的原话是「选中多个文字进行删除」。
    //      上面验的是「选得对」，这里验「按 Delete 之后确实删掉了选中的那些字」。
    const DELETE_DOC = "AAAABBBBCCCC";
    await evaluate(`window.__setViewMode("live");`);
    await sleep(500);
    await evaluate(`window.__openDemo(${JSON.stringify(DELETE_DOC)}, "D:/notes/delete.md");`);
    await sleep(700);
    await dragSelect(0, 4);
    const beforeDelete = await evaluate("window.__getDoc()");
    const selectedCount = JSON.parse(await evaluate("JSON.stringify(window.__getSelection())"));
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Delete",
      code: "Delete",
      windowsVirtualKeyCode: 46,
      nativeVirtualKeyCode: 46,
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
    await sleep(300);
    const afterDelete = await evaluate("window.__getDoc()");
    check(
      "拖选 4 个字符后按 Delete，正好删掉这 4 个",
      beforeDelete === DELETE_DOC && selectedCount?.from === 0 && selectedCount?.to === 4 && afterDelete === "BBBBCCCC",
      `拖选=${JSON.stringify(selectedCount)} 删除前=${beforeDelete} 删除后=${afterDelete}`,
    );

    console.log(`\nSUMMARY pass=${passCount} fail=${failCount} total=${passCount + failCount}`);
    console.log("=============================================");

    if (failCount > 0) process.exitCode = 1;
    ws.close();
  } catch (err) {
    console.error("[selection] 失败：", err.message);
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
