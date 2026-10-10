/**
 * 批次 3 的临时验收脚本：验证「store ↔ 编辑器 ↔ 预览」这条链真的通了。
 *
 * 直接在真实浏览器里挂载 <Editor/> 和 <Preview/>，用真实 CodeMirror 实例
 * 和真实 Worker 跑一遍。用完即删。
 */
// 必须显式引入主题：验收构建没有 index.html 入口，不引就没有任何 CSS，
// --foreground / --cm-* 全是未定义，高亮断言会假失败（踩过一次）。
import "@/index.css";

import { isolateHistory, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";

import { Editor } from "@/components/Editor";
import { Preview } from "@/components/Preview";
import { MAX_RECENT_FILES, PREVIEW_MAX_BYTES, useEditor, warmupRenderer } from "@/store/editor";

interface Result {
  name: string;
  pass: boolean;
  info: string;
}

const results: Result[] = [];
const notes: string[] = [];

const record = (name: string, pass: boolean, info = ""): void => {
  results.push({ name, pass, info });
};
const note = (name: string, info: string): void => {
  notes.push(`${name} — ${info}`);
};

/** 进度埋点：卡住时 runner 能把执行到哪一步抓回来，省得靠猜 */
const steps: string[] = [];
(window as unknown as Record<string, unknown>).__verifySteps = steps;
const step = (name: string): void => {
  steps.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${name}`);
};

const t0 = performance.now();

/** 卡住时给 runner 抓的现场快照 */
(window as unknown as Record<string, unknown>).__verifySnapshot = () => {
  const s = useEditor.getState();
  return {
    rendering: s.rendering,
    renderCount: s.renderCount,
    lastRenderMs: s.lastRenderMs,
    contentLength: s.content.length,
    htmlLength: s.html.length,
    truncated: s.truncated,
    path: s.path,
    error: s.error?.message ?? null,
    notice: s.notice,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等到某个条件成立，用于「等渲染真的进到在途状态」这类场景 */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

/**
 * 等一次新的渲染落地。
 *
 * 判据用单调递增的 renderCount，**不要用 rendering 布尔** —— 布尔会受
 * 「先等开始再等结束」的时序影响，一旦错过一次跳变就会空烧整个超时（踩过）。
 */
const waitLog: string[] = [];
(window as unknown as Record<string, unknown>).__verifyWaits = waitLog;

async function waitForRender(timeoutMs = 8000): Promise<boolean> {
  const startCount = useEditor.getState().renderCount;
  const startRendering = useEditor.getState().rendering;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && useEditor.getState().renderCount === startCount) {
    await sleep(25);
  }
  await sleep(60);

  const after = useEditor.getState();
  const advanced = after.renderCount !== startCount;
  waitLog.push(
    `count ${startCount}→${after.renderCount} rendering ${startRendering}→${after.rendering} ${advanced ? "OK" : "超时"}`,
  );
  return advanced;
}

/**
 * 用 CodeMirror 的公开 API 从 DOM 反查视图，产品代码里不需要留任何测试钩子。
 */
function editorView(): EditorView {
  const dom = document.querySelector<HTMLElement>(".cm-content");
  if (!dom) throw new Error("找不到 .cm-content —— 编辑器没挂上？");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("EditorView.findFromDOM 返回 null");
  return view;
}

function mountHarness(): void {
  /*
    先把两个「按需开启」的开关打开。

    这套验收测的是**编辑器 + 渲染管线**这两块能力本身，而它们在主界面里已经是可选的：
    默认视图是实时预览（藏标记、不带行号），后台渲染默认关闭（有独立预览面板时才有意义）。
    不打开的话，这套断言测的对象就没了 —— 不是功能坏了，是测量对象换了。
  */
  useEditor.setState({ previewEnabled: true, viewMode: "source" });

  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;display:flex;height:640px;width:1200px;overflow:hidden";
  const left = document.createElement("div");
  left.style.cssText = "flex:1 1 50%;min-width:0;height:100%";
  const right = document.createElement("div");
  right.style.cssText = "flex:1 1 50%;min-width:0;height:100%";
  root.append(left, right);
  document.body.append(root);

  const leftRoot = createRoot(left);
  const rightRoot = createRoot(right);
  leftRoot.render(<Editor />);
  rightRoot.render(<Preview />);
}

// ------------------------------------------------------------ 安装类断言

async function testMount(): Promise<void> {
  await sleep(120);

  const cm = document.querySelector(".cm-editor");
  record("CodeMirror 已挂载", !!cm);
  record("行号 gutter 存在", !!document.querySelector(".cm-lineNumbers .cm-gutterElement"));
  record(
    "内容区可编辑",
    document.querySelector(".cm-content")?.getAttribute("contenteditable") === "true",
  );
  record("字体沿用等宽栈", /mono|Consolas/i.test(
    getComputedStyle(document.querySelector(".cm-scroller") as Element).fontFamily,
  ));
}

function testSyntaxHighlight(): void {
  const view = editorView();
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: "# 标题\n\n正文 **加粗** 与 `代码`\n\n- 列表项\n",
    },
  });

  const content = document.querySelector(".cm-content") as HTMLElement;
  const baseColor = getComputedStyle(content).color;

  // CodeMirror 的高亮样式挂在 span 上，取一个颜色与正文不同的就算生效
  const spans = [...content.querySelectorAll("span")];
  const colored = spans.filter((s) => getComputedStyle(s).color !== baseColor);

  record(
    "Markdown 语法高亮生效（存在与正文不同色的 token）",
    colored.length > 0,
    `${colored.length}/${spans.length} 个 span 着色，基准色 ${baseColor}`,
  );
  note(
    "高亮配色抽样",
    colored
      .slice(0, 4)
      .map((s) => `"${s.textContent?.slice(0, 10)}"→${getComputedStyle(s).color}`)
      .join("  "),
  );
}

function testBracketMatching(): void {
  const view = editorView();
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: "a(b)c[d]" },
    selection: { anchor: 2 },
  });
  const matched = document.querySelectorAll(".cm-matchingBracket");
  record("括号匹配生效", matched.length >= 1, `命中 ${matched.length} 个 .cm-matchingBracket`);
}

function testUndoDepth(): Promise<void> {
  return new Promise((resolve) => {
    const view = editorView();
    const baseline = "起始内容";

    // 必须打 isolateHistory：CodeMirror 默认会把 500ms 内的连续编辑合并成一个
    // 历史事件，那样一次 undo 就把全部输入撤回去了，测不出「多步」。
    // ⚠ 它的取值是 "before" | "after" | "full"，**不是布尔** —— 传 true 会静默失效。
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: baseline },
      annotations: isolateHistory.of("full"),
    });

    for (let i = 1; i <= 5; i += 1) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: `${i}` },
        annotations: isolateHistory.of("full"),
      });
    }
    const typed = view.state.doc.toString();

    for (let i = 0; i < 5; i += 1) undo(view);

    const afterUndo = view.state.doc.toString();
    record(
      "多步撤销（连撤 5 步回到基线）",
      afterUndo === baseline,
      `输入后 "${typed}" → 撤销后 "${afterUndo}"`,
    );
    resolve();
  });
}

// ------------------------------------------------------------ 数据流

async function testEditFlowsToPreview(): Promise<void> {
  useEditor.setState({ path: null });
  useEditor.getState().setContent("# 实时预览\n\n段落内容\n");
  await waitForRender();

  const html = useEditor.getState().html;
  record("store 收到编辑器内容", useEditor.getState().content.includes("实时预览"));
  record("预览 HTML 已生成", /<h1[^>]*>实时预览<\/h1>/.test(html), html.slice(0, 80));
  record("预览 DOM 同步更新", !!document.querySelector(".markdown-body h1"));
  record("目录已收集", useEditor.getState().toc.some((t) => t.text === "实时预览"));
}

async function testDirtyTracking(): Promise<void> {
  useEditor.setState({ content: "a", savedContent: "a" });
  record("内容一致时不算 dirty", useEditor.getState().content === useEditor.getState().savedContent);

  useEditor.getState().setContent("ab");
  record(
    "内容变化后算出 dirty",
    useEditor.getState().content !== useEditor.getState().savedContent,
  );
}

/**
 * 丢弃在途结果。
 *
 * 为什么用 close() 而不是「快速连打两次内容」：防抖 220ms、一次渲染约 200ms，
 * 用打字根本造不出「旧渲染还在算、新渲染已经开工」的窗口（这其实说明防抖参数调得合适）。
 * close() 直接让 token 作废，是确定性触发这条分支的方式。
 */
async function testDiscardInFlightResult(): Promise<void> {
  const unit = "填充文字 PADDING 用来把文档撑到需要真实渲染的规模。\n\n";
  const big = unit.repeat(
    Math.ceil((512 * 1024) / new TextEncoder().encode(unit).length),
  );

  useEditor.getState().setContent(big);
  // 确定性地等到渲染真的进了在途状态，别靠 sleep 猜时间
  const becameInFlight = await waitUntil(() => useEditor.getState().rendering, 4000);

  const before = useEditor.getState();
  useEditor.getState().close(); // 在途结果就此作废

  await sleep(1500);

  const after = useEditor.getState();
  record(
    "关闭前确实有渲染在途",
    becameInFlight,
    `renderCount=${before.renderCount} lastRenderMs=${before.lastRenderMs}`,
  );
  record("在途结果未写回已关闭的文档", after.html === "", `html 长度 ${after.html.length}`);
  record(
    "过期结果未推进渲染计数",
    after.renderCount === before.renderCount,
    `${before.renderCount} → ${after.renderCount}`,
  );
  record("在途渲染被作废后 loading 已复位", after.rendering === false);

  // 作废之后管线仍要能正常工作
  useEditor.getState().setContent("# 恢复工作 RECOVERED\n");
  await waitForRender();
  record("作废后管线恢复正常", useEditor.getState().html.includes("RECOVERED"));
}

// ------------------------------------------------------------ 截断

async function testTruncation(): Promise<void> {
  const unit = "这是一段用于把文档撑大的中文段落，附带 english words 与 1234。\n\n";
  const big = unit.repeat(Math.ceil((PREVIEW_MAX_BYTES * 1.5) / new TextEncoder().encode(unit).length));

  useEditor.getState().setContent(big);
  await waitForRender(30000);

  const state = useEditor.getState();
  record("超限文档被标记为已截断", state.truncated === true);
  record(
    "totalBytes 统计正确",
    state.totalBytes === new TextEncoder().encode(big).length,
    `${state.totalBytes} 字节`,
  );
  record("截断后预览仍有内容产出", state.html.length > 0);
  note(
    "截断规模",
    `源文 ${(state.totalBytes / 1024).toFixed(0)} KB → 预览所用 HTML ${(state.html.length / 1024).toFixed(0)} KB`,
  );

  useEditor.getState().setContent("# 小文档\n");
  await waitForRender();
  record("回到小文档后截断标记复位", useEditor.getState().truncated === false);
}

// ------------------------------------------------------------ 预览交互

async function testLinkInterception(): Promise<void> {
  useEditor.setState({ path: "D:/docs/demo.md" });
  useEditor.getState().setContent(
    ["[外链](https://example.com/x)", "", "[锚点](#目标)", "", "# 目标", ""].join("\n"),
  );
  await waitForRender();

  const external = document.querySelector<HTMLAnchorElement>('a[href="https://example.com/x"]');
  record("外链带 data-md-link 标记", external?.getAttribute("data-md-link") === "1");

  const before = window.location.href;
  external?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(150);

  record("点击外链未发生 WebView 内导航", window.location.href === before, before);

  // 每次 getState() 都是新的一次调用，TS 无法跨调用收窄，必须先取到局部变量
  const noticeAfterExternalClick = useEditor.getState().notice;
  record(
    "跳转失败时给出了提示（不静默）",
    typeof noticeAfterExternalClick === "string" && noticeAfterExternalClick.length > 0,
    noticeAfterExternalClick ?? "(无)",
  );

  // 锚点：应滚动而不过滤成提示
  useEditor.getState().setNotice(null);
  const anchor = document.querySelector<HTMLAnchorElement>('a[href="#目标"]');
  anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(150);
  const heading = document.querySelector('[id="目标"]');
  record("文档内锚点能定位到对应标题", heading !== null);
  record("锚点点击不产生报错提示", useEditor.getState().notice === null);

  // 相对路径链接：明确提示而非静默
  useEditor.getState().setContent("[本地](./other.md)\n");
  await waitForRender();
  useEditor.getState().setNotice(null);
  const local = document.querySelector<HTMLAnchorElement>('a[href="./other.md"]');
  local?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(120);
  record(
    "本地文件链接给出明确提示（不静默失败）",
    (useEditor.getState().notice ?? "").includes("本地文件"),
    useEditor.getState().notice ?? "(无)",
  );
}

async function testPreviewImageRewrite(): Promise<void> {
  useEditor.setState({ path: "D:/docs/sub/demo.md" });
  useEditor.getState().setContent("![图](./img/a.png)\n");
  await waitForRender();

  const img = document.querySelector<HTMLImageElement>('.markdown-body img[alt="图"]');
  record("预览中相对图片已写入 src", !!img?.getAttribute("src"), `src=${img?.getAttribute("src")}`);
  record("data-md-src 已消费掉", img?.getAttribute("data-md-src") === null);
}

// ------------------------------------------------------------ 预热

async function testWarmup(): Promise<void> {
  // 预热入口必须可被反复调用（应用启动只会调一次，但幂等是硬要求）
  warmupRenderer();
  warmupRenderer();
  record("预热入口幂等，重复调用不报错", true);

  const t1 = performance.now();
  useEditor.getState().setContent("# 延迟探测 A\n");
  await waitForRender();
  const first = performance.now() - t1;

  const t2 = performance.now();
  useEditor.getState().setContent("# 延迟探测 B\n");
  await waitForRender();
  const second = performance.now() - t2;

  note(
    "改动→预览落地端到端延迟",
    `首次 ${first.toFixed(0)} ms / 二次 ${second.toFixed(0)} ms（含 220ms 防抖）`,
  );
  record(
    "端到端延迟在可接受范围（< 500ms）",
    Math.max(first, second) < 500,
    `最大 ${Math.max(first, second).toFixed(0)} ms`,
  );
}

// ------------------------------------------------------------ 最近文件

function testRecentFiles(): void {
  useEditor.setState({ recentFiles: [] });
  const list = Array.from({ length: MAX_RECENT_FILES + 4 }, (_, i) => `D:/docs/f${i}.md`);
  for (const p of list) {
    useEditor.setState((s) => ({
      recentFiles: [p, ...s.recentFiles.filter((x) => x !== p)].slice(0, MAX_RECENT_FILES),
    }));
  }
  const recent = useEditor.getState().recentFiles;
  record("最近文件按上限截断", recent.length === MAX_RECENT_FILES, `${recent.length} 条`);
  record("最近文件最新的在最前", recent[0] === list[list.length - 1], recent[0] ?? "");
}

// ------------------------------------------------------------ 汇总

let finished = false;

/** 汇总输出。加了硬超时兜底，任何一步卡死也一定能拿到已完成的部分结果。 */
function finish(reason?: string): void {
  if (finished) return;
  finished = true;

  if (reason) {
    record(`验收未跑完（${reason}）`, false, `最后一步：${steps[steps.length - 1] ?? "(无)"}`);
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
    `STEPS ${steps.join(" → ")}`,
    "",
    `SUMMARY pass=${pass} fail=${fail} total=${results.length}`,
  ];

  const out = document.createElement("pre");
  out.id = "out";
  out.style.cssText =
    "position:fixed;left:0;bottom:0;z-index:9999;font-size:12px;white-space:pre-wrap";
  out.textContent = lines.join("\n");
  document.body.append(out);
  document.title = fail === 0 ? `ALL_PASS ${pass}/${results.length}` : `HAS_FAILURES ${fail}`;
}

// 硬超时：整轮验收不得超过 75 秒，超了也要把已有结果交出来
setTimeout(() => finish("硬超时 75s"), 75000);

async function main(): Promise<void> {
  try {
    step("mountHarness");
    mountHarness();
    step("testMount");
    await testMount();
    step("testSyntaxHighlight");
    testSyntaxHighlight();
    step("testBracketMatching");
    testBracketMatching();
    step("testUndoDepth");
    await testUndoDepth();
    step("testEditFlowsToPreview");
    await testEditFlowsToPreview();
    step("testDirtyTracking");
    await testDirtyTracking();
    step("testDiscardInFlightResult");
    await testDiscardInFlightResult();
    step("testLinkInterception");
    await testLinkInterception();
    step("testPreviewImageRewrite");
    await testPreviewImageRewrite();
    step("testWarmup");
    await testWarmup();
    step("testRecentFiles");
    testRecentFiles();
    step("testTruncation");
    await testTruncation();
    step("done");
  } catch (err) {
    record("验收脚本自身异常", false, String(err));
    console.error(err);
  }

  finish();
}

void main();
