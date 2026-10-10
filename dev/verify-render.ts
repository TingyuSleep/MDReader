/**
 * 批次 2 的临时验收脚本。
 *
 * 走真实的 Vite dev server + 真实 Chrome，把渲染管线三条腿（解析 / 清洗 / 图片定位）
 * 全部跑一遍，重点是 XSS 必须实测而不是靠推断。验证完即删除。
 */
import { parseMarkdown } from "@/lib/markdown-parse";
import { resolveRelativePath } from "@/lib/markdown-path";
import { resolveAssetImages } from "@/lib/asset-images";
import { sanitizeHtml } from "@/lib/markdown-sanitize";
import type { RenderRequest, RenderResponse } from "@/lib/worker/render.worker";

interface Result {
  name: string;
  pass: boolean;
  info: string;
}

const results: Result[] = [];
const notes: string[] = [];

/** 断言 */
const record = (name: string, pass: boolean, info = ""): void => {
  results.push({ name, pass, info });
};

/** 只报数值，不参与通过判定 */
const note = (name: string, info: string): void => {
  notes.push(`${name} — ${info}`);
};

const F = "```";

const SAMPLE = [
  "# 一级标题",
  "",
  "## 安装",
  "",
  "### 安装",
  "",
  "| 名称 | 版本 |",
  "| --- | --- |",
  "| tauri | 2 |",
  "",
  "- [ ] 待办项",
  "- [x] 已完成项",
  "",
  "~~删掉的文字~~",
  "",
  "自动链接 https://example.com/path?q=1",
  "",
  "![相对图](./img/a.png)",
  "",
  "![远程图](https://example.com/b.png)",
  "",
  "![空格图](<图片/我的 图.png>)",
  "",
  F + "rust",
  'fn main() { println!("hi"); }',
  F,
  "",
  F + "冷门语言xyz",
  "some plain text",
  F,
  "",
  F + "text",
  "should stay plain",
  F,
  "",
].join("\n");

const XSS_PAYLOADS = [
  "<script>window.__xssA=1</script>",
  '<img src=x onerror="window.__xssB=1">',
  "<iframe src='https://example.com'></iframe>",
  '<svg onload="window.__xssC=1"></svg>',
  '<a href="javascript:window.__xssD=1">x</a>',
  "[点我](javascript:window.__xssE=1)",
  "<style>body{background:url(javascript:window.__xssF=1)}</style>",
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 解析 + 清洗

function testParse(): { rawHtml: string; cleanHtml: string } {
  const { html: rawHtml, toc } = parseMarkdown(SAMPLE);

  record("GFM 表格", /<table>/.test(rawHtml));
  record(
    "GFM 任务列表",
    /<input[^>]*type="checkbox"/.test(rawHtml) && /contains-task-list/.test(rawHtml),
    "复选框须保留（预览只读）",
  );
  record("GFM 删除线", /<s>删掉的文字<\/s>/.test(rawHtml));
  record("GFM 自动链接", /<a[^>]*href="https:\/\/example\.com\/path\?q=1"/.test(rawHtml));
  record("代码块高亮", /<span class="hljs-/.test(rawHtml) && rawHtml.includes('data-lang="rust"'));

  // 这两条用 DOM 查，避免正则跨越相邻代码块误判
  const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
  const unknownBlock = [...parsed.querySelectorAll("pre")].find(
    (pre) => pre.getAttribute("data-lang") === "冷门语言xyz",
  );
  record(
    "未注册语言不崩且降级为纯文本",
    !!unknownBlock && unknownBlock.querySelector(".hljs") === null,
    `含 ${unknownBlock?.querySelectorAll("span").length ?? "?"} 个 span`,
  );

  const textBlock = [...parsed.querySelectorAll("pre")].find(
    (pre) => pre.getAttribute("data-lang") === "text",
  );
  record(
    "text 标记不高亮",
    !!textBlock && textBlock.querySelector(".hljs") === null,
    textBlock?.textContent?.trim(),
  );

  record(
    "目录收集正确",
    toc.length === 3 && toc[0]?.level === 1 && toc[1]?.level === 2 && toc[2]?.level === 3,
    toc.map((t) => `h${t.level}:${t.id}`).join(" "),
  );
  record(
    "重名标题锚点去重",
    toc[1]?.id === "安装" && toc[2]?.id === "安装-2",
    `${toc[1]?.id} / ${toc[2]?.id}`,
  );

  // 图片断言走 DOM。用正则会踩一个坑：data-md-src="./img/a.png" 里
  // 本身就含有 src="./img/a.png" 子串，"不写 src" 那条会被自己骗过去。
  const imgRelative = parsed.querySelector<HTMLImageElement>('img[alt="相对图"]');
  record(
    "相对路径图片：不写 src，改挂 data-md-src",
    imgRelative?.getAttribute("src") === null &&
      imgRelative?.getAttribute("data-md-src") === "./img/a.png",
    `src=${imgRelative?.getAttribute("src")} data-md-src=${imgRelative?.getAttribute("data-md-src")}`,
  );

  const imgRemote = parsed.querySelector<HTMLImageElement>('img[alt="远程图"]');
  record(
    "远程图片：src 直接可用",
    imgRemote?.getAttribute("src") === "https://example.com/b.png",
  );

  const imgSpace = parsed.querySelector<HTMLImageElement>('img[alt="空格图"]');
  const spaceSrc = imgSpace?.getAttribute("data-md-src") ?? "";
  record(
    "含空格中文路径：编码后可还原成真实路径",
    resolveRelativePath("D:/docs", spaceSrc) === "D:/docs/图片/我的 图.png",
    `data-md-src=${spaceSrc}`,
  );

  record("链接统一打 data-md-link 标记", rawHtml.includes('data-md-link="1"'));
  record("链接不带 target（禁止 WebView 内导航）", !/<a[^>]*target=/.test(rawHtml));
  record(
    "javascript: 链接被 markdown-it 拦掉",
    !/href="javascript:/i.test(rawHtml),
    "第一道防线：validateLink",
  );

  const cleanHtml = sanitizeHtml(rawHtml);

  record("清洗后：hljs 高亮 span 保留", /<span class="hljs-/.test(cleanHtml));
  record("清洗后：data-lang 保留", cleanHtml.includes('data-lang="rust"'));
  record("清洗后：data-md-src 保留", cleanHtml.includes('data-md-src="./img/a.png"'));
  record("清洗后：data-md-link 保留", cleanHtml.includes('data-md-link="1"'));
  record("清洗后：任务列表复选框保留", /<input[^>]*type="checkbox"/.test(cleanHtml));
  record("清洗后：表格保留", /<table>/.test(cleanHtml));

  return { rawHtml, cleanHtml };
}

// ------------------------------------------------------------ XSS 实测

async function testXss(): Promise<void> {
  const { html: rawHtml } = parseMarkdown(XSS_PAYLOADS.join("\n\n"));
  const cleanHtml = sanitizeHtml(rawHtml);

  record("XSS：源文原始 HTML 被转义（html:false）", !/<script/i.test(rawHtml), "第一道防线生效");
  record("XSS：清洗后无 <script>", !/<script/i.test(cleanHtml));
  record("XSS：清洗后无 iframe", !/<iframe/i.test(cleanHtml));
  record("XSS：清洗后无 svg", !/<svg/i.test(cleanHtml));
  record("XSS：清洗后无 style 标签", !/<style/i.test(cleanHtml));

  // 下面两条必须查 DOM，不能查字符串：
  // payload 被转义成文本后，正文里仍然存在 " onerror=" 和 "javascript:" 这些字面量，
  // 用正则扫字符串会把「无害的文本」误判成「危险属性」。
  const xssDoc = new DOMParser().parseFromString(cleanHtml, "text/html");

  const eventAttrs: string[] = [];
  for (const el of xssDoc.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (attr.name.toLowerCase().startsWith("on")) eventAttrs.push(`${el.tagName}[${attr.name}]`);
    }
  }
  record("XSS：清洗后无事件处理属性", eventAttrs.length === 0, eventAttrs.join(",") || "已全数剥离");

  const jsProtocol: string[] = [];
  for (const el of xssDoc.querySelectorAll("[href], [src], [action], [formaction]")) {
    for (const name of ["href", "src", "action", "formaction"]) {
      const value = el.getAttribute(name);
      if (value && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
        jsProtocol.push(`${el.tagName}[${name}]=${value.slice(0, 40)}`);
      }
    }
  }
  record("XSS：清洗后无危险协议", jsProtocol.length === 0, jsProtocol.join(",") || "已全数剥离");

  // 真机验证：塞进 DOM，看有没有真的执行
  const host = document.createElement("div");
  host.style.display = "none";
  document.body.appendChild(host);
  host.innerHTML = cleanHtml;
  await sleep(80);

  const w = window as unknown as Record<string, unknown>;
  const fired = ["__xssA", "__xssB", "__xssC", "__xssD", "__xssE", "__xssF"].filter(
    (k) => w[k] !== undefined,
  );
  record(
    "XSS：真实插入 DOM 后无一执行",
    fired.length === 0,
    fired.length ? `被触发：${fired.join(",")}` : "6 类 payload 全部被拦",
  );
  host.remove();
}

// ------------------------------------------------------------ 路径解析

function testPathResolution(): void {
  const cases: Array<[string, string, string, string]> = [
    ["普通相对路径", "D:/docs", "./img/a.png", "D:/docs/img/a.png"],
    ["上级目录", "D:/docs/sub", "../a.png", "D:/docs/a.png"],
    ["多重上溯不越界", "D:/docs", "a/../../b.png", "D:/b.png"],
    ["URL 编码还原", "D:/docs", "图片/我的%20图.png", "D:/docs/图片/我的 图.png"],
    ["Windows 反斜杠绝对路径", "D:/docs", "C:\\x\\y.png", "C:/x/y.png"],
    ["盘符内绝对路径", "D:/docs", "/abs/a.png", "D:/abs/a.png"],
    ["反斜杠相对路径", "D:/docs", "images\\sub\\a.png", "D:/docs/images/sub/a.png"],
    ["baseDir 带末尾斜杠", "D:/docs/", "a.png", "D:/docs/a.png"],
  ];

  for (const [name, base, raw, expected] of cases) {
    const actual = resolveRelativePath(base, raw);
    record(
      `路径解析：${name}`,
      actual === expected,
      actual === expected ? "" : `期望 ${expected} / 实际 ${actual}`,
    );
  }
}

function testImageRewrite(): void {
  const cleanHtml = sanitizeHtml(parseMarkdown(SAMPLE).html);
  const host = document.createElement("div");
  host.innerHTML = cleanHtml;

  const count = resolveAssetImages(host, "D:/docs");
  const relative = host.querySelector<HTMLImageElement>('img[alt="相对图"]');
  const remote = host.querySelector<HTMLImageElement>('img[alt="远程图"]');

  record("resolveAssetImages 处理了相对路径图片", count >= 1, `修正 ${count} 张`);
  record(
    "非 Tauri 环境降级且不抛错",
    relative?.getAttribute("src") === "./img/a.png",
    `src=${relative?.getAttribute("src")}`,
  );
  record("处理后 data-md-src 已移除", relative?.getAttribute("data-md-src") === null);
  record("远程图片不受影响", remote?.getAttribute("src") === "https://example.com/b.png");
}

// ------------------------------------------------------------ Worker 往返

function renderViaWorker(source: string, id = 42): Promise<RenderResponse> {
  return new Promise<RenderResponse>((resolve, reject) => {
    const worker = new Worker(new URL("../src/lib/worker/render.worker.ts", import.meta.url), {
      type: "module",
    });

    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      worker.terminate();
      return true;
    };

    const timer = setTimeout(() => {
      if (finish()) reject(new Error("Worker 15s 未响应"));
    }, 15000);

    worker.addEventListener("message", (event: MessageEvent<RenderResponse>) => {
      clearTimeout(timer);
      if (finish()) resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timer);
      if (finish()) reject(new Error(`Worker error: ${event.message}`));
    });

    const request: RenderRequest = { id, type: "render", source };
    worker.postMessage(request);
  });
}

async function testWorker(): Promise<void> {
  try {
    const response = await renderViaWorker(SAMPLE);
    record("Worker 回传类型正确", response.type === "rendered");
    record("Worker 原样回传 id（用于丢弃过期结果）", response.id === 42, `id=${response.id}`);

    if (response.type === "rendered") {
      record("Worker 产出的 HTML 可用", /<table>/.test(response.html));
      record("Worker 产出目录", response.toc.length === 3);
      note("小文档往返耗时", `${response.ms.toFixed(1)} ms（${(SAMPLE.length / 1024).toFixed(1)} KB 源文）`);
    }
  } catch (err) {
    record("Worker 往返", false, String(err));
  }
}

// ------------------------------------------------------------ 1MB 性能

function buildLargeDocument(targetBytes: number): string {
  const unit = [
    "## 性能测试小节",
    "",
    "这是一段用于压测的普通中文段落，包含若干标点、英文 words 与 1234 数字。",
    "",
    "- 列表项一",
    "- 列表项二",
    "",
    F + "js",
    "const x = 1; function f(a) { return a * 2 }",
    F,
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
  ].join("\n");

  const unitBytes = new TextEncoder().encode(unit).length;
  return unit.repeat(Math.ceil(targetBytes / unitBytes));
}

async function testPerformance(): Promise<void> {
  // 分三档采样：目的是拿到「多大的文档会让主线程清洗开始变成肉眼可见的卡顿」这条曲线，
  // 好决定预览区要不要设一个体积阈值。
  for (const sizeKb of [64, 256, 1024]) {
    const doc = buildLargeDocument(sizeKb * 1024);
    const actualKb = new TextEncoder().encode(doc).length / 1024;

    try {
      const response = await renderViaWorker(doc, 7);
      if (response.type !== "rendered") {
        record(`${sizeKb} KB 解析`, false, `Worker 返回错误：${response.error.message}`);
        continue;
      }

      const t0 = performance.now();
      const clean = sanitizeHtml(response.html);
      const sanitizeMs = performance.now() - t0;

      note(
        `${sizeKb} KB 文档`,
        `源文 ${actualKb.toFixed(0)} KB → HTML ${(response.html.length / 1024).toFixed(0)} KB` +
          ` | Worker 解析 ${response.ms.toFixed(0)} ms | 主线程清洗 ${sanitizeMs.toFixed(0)} ms` +
          ` | 解析+清洗 ${(response.ms + sanitizeMs).toFixed(0)} ms`,
      );

      if (sizeKb === 1024) {
        record("1MB 解析不崩且产出完整 HTML", /<table>/.test(clean) && clean.length > 100_000);
        record(
          "1MB 主线程单次阻塞上限（宽松兜底 ≤ 1500ms）",
          sanitizeMs <= 1500,
          `实际 ${sanitizeMs.toFixed(0)} ms —— 与 50ms 目标差距需要单独决策`,
        );
      }
    } catch (err) {
      record(`${sizeKb} KB 解析`, false, String(err));
    }
  }
}

// ------------------------------------------------------------ 汇总输出

async function main(): Promise<void> {
  try {
    testParse();
    testPathResolution();
    await testXss();
    testImageRewrite();
    await testWorker();
    await testPerformance();
  } catch (err) {
    record("验收脚本自身异常", false, String(err));
    console.error(err);
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;

  const lines = [
    ...results.map(
      (r, i) =>
        `${r.pass ? "PASS" : "FAIL"} ${String(i + 1).padStart(2, "0")} ${r.name}${r.info ? ` | ${r.info}` : ""}`,
    ),
    ...(notes.length ? ["", ...notes.map((n) => `NOTE | ${n}`)] : []),
    "",
    `SUMMARY pass=${pass} fail=${fail} total=${results.length}`,
  ];

  const out = document.getElementById("out");
  if (out) out.textContent = lines.join("\n");
  document.title = fail === 0 ? `ALL_PASS ${pass}/${results.length}` : `HAS_FAILURES ${fail}`;
}

void main();
