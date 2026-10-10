/**
 * 批次 9 的临时验收脚本：状态栏 + 窗口标题。用完即删。
 *
 * 分三层验，因为这三层的失败方式完全不同：
 *
 *   1. **度量规则**（纯函数）。中日韩逐字、emoji 按码点、连字符不断词、结尾换行算一行 ——
 *      这些规则只要有一条写歪，显示出来的数字就是"看着差不多但不对"，肉眼看不出。
 *      所以逐条钉死。
 *
 *   2. **状态栏接线**。挂的是真正的 <App/>，验的是「store 里的状态有没有正确流到 UI 上」：
 *      编码/换行符/视图模式文案、以及拖选之后光标位置有没有跟着动。
 *      光标那条尤其重要 —— 它是靠 `document.addEventListener("selectionchange")` 订阅的，
 *      这条假设不成立的话状态栏会永远停在"行 — 列 —"。
 *
 *   3. **窗口标题**。这里只能验「我们生成的标题字符串对不对」，
 *      真正"窗口标题栏有没有变"必须在真机应用里看（浏览器里没有窗口标题这个概念）。
 *
 * ⚠ 标题三条断言必须放在**最后**：App 的标题 effect 会在 path/dirty 变化时覆盖
 *   `document.title`，而验收驱动器正是靠 document.title 回传 PASS/FAIL 的。
 *   放在最后 + finish() 里再写一次标题，才不会被抢。
 */
// 验收构建没有 index.html 入口，必须显式引主题，否则 --* 令牌全未定义
import "@/index.css";

import { createRoot } from "react-dom/client";

import App from "@/App";
import { getActiveEditorView } from "@/components/Editor";
import { countWords, formatCursor, measureDocument } from "@/lib/status-metrics";
import { useEditor } from "@/store/editor";

// ------------------------------------------------------------ 骨架

interface Result {
  name: string;
  pass: boolean;
  info: string;
}

const results: Result[] = [];
const record = (name: string, pass: boolean, info = ""): void => {
  results.push({ name, pass, info });
};

const steps: string[] = [];
(window as unknown as Record<string, unknown>).__verifySteps = steps;
const t0 = performance.now();
const step = (name: string): void => {
  steps.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${name}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等一帧再等一个宏任务 —— React 的 effect 在 paint 之后跑，只等 rAF 会读到旧标题 */
const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const statusText = (): string =>
  (document.querySelector("footer")?.textContent ?? "").replace(/\s+/g, " ").trim();

(window as unknown as Record<string, unknown>).__verifySnapshot = () => ({
  hasStatusBar: !!document.querySelector("footer"),
  statusText: statusText(),
  documentTitle: document.title,
  contentLength: useEditor.getState().content.length,
  hasEditor: !!document.querySelector(".cm-editor"),
  editorViewMode: useEditor.getState().viewMode,
});

// ------------------------------------------------------------ 1. 度量规则

function testMetrics(): void {
  const empty = measureDocument("");
  record(
    "空文档：字数/字符/行数全为 0（不是「行 1」）",
    empty.words === 0 && empty.chars === 0 && empty.charsNoSpace === 0 && empty.lines === 0,
    JSON.stringify(empty),
  );

  record("西文按词计：hello world = 2", countWords("hello world") === 2, String(countWords("hello world")));
  record("中日韩逐字：你好世界 = 4", countWords("你好世界") === 4, String(countWords("你好世界")));
  record(
    "中英混排相加：hello世界 = 3（hello 是 1 个词 + 世界 2 个字）",
    countWords("hello世界") === 3,
    String(countWords("hello世界")),
  );
  record(
    "连字符不断词：well-known = 1",
    countWords("well-known") === 1,
    String(countWords("well-known")),
  );
  record("撇号不断词：don't = 1", countWords("don't") === 1, String(countWords("don't")));
  record("数字自成词：v2 = 1", countWords("v2") === 1, String(countWords("v2")));
  // 扩展 B 的「𠮷」与假名、谚文都不能漏，否则日文/生僻字文档字数直接归零
  record("扩展 B 生僻字算字：𠮷 = 1", countWords("𠮷") === 1, String(countWords("𠮷")));
  record("假名算字：かな = 2", countWords("かな") === 2, String(countWords("かな")));
  record("谚文算字：한글 = 2", countWords("한글") === 2, String(countWords("한글")));

  const emoji = measureDocument("😀中");
  record(
    "字符按码点：😀中 = 2 字符（不是 3）",
    emoji.chars === 2 && emoji.charsNoSpace === 2,
    `${emoji.chars}/${emoji.charsNoSpace}`,
  );

  const spaced = measureDocument("a b");
  record(
    "含空格与不含空格分开算：a b → 3 / 2",
    spaced.chars === 3 && spaced.charsNoSpace === 2,
    `${spaced.chars}/${spaced.charsNoSpace}`,
  );

  record("行数：a\\nb = 2 行", measureDocument("a\nb").lines === 2, String(measureDocument("a\nb").lines));
  record(
    "结尾换行多算一个空行：a\\n = 2 行（与编辑器显示一致）",
    measureDocument("a\n").lines === 2,
    String(measureDocument("a\n").lines),
  );

  const mixed = measureDocument("中文 Markdown");
  record(
    "综合：中文 Markdown → 3 词 / 11 字符 / 10 非空",
    mixed.words === 3 && mixed.chars === 11 && mixed.charsNoSpace === 10,
    JSON.stringify(mixed),
  );

  record("光标文案：formatCursor(3, 7)", formatCursor(3, 7) === "行 3 列 7", formatCursor(3, 7));
}

// ------------------------------------------------------------ 2. 状态栏接线

const DOC = "abc\ndef";

/** 模拟已打开一份文档。真实 open() 要 invoke，浏览器里走不通。 */
function setDocument(text: string, path: string | null, opts: { dirty?: boolean } = {}): void {
  const state = useEditor.getState();
  useEditor.setState({
    path,
    content: text,
    savedContent: opts.dirty ? "" : text,
    encoding: path ? "utf-8" : null,
    eol: path ? "lf" : null,
    documentId: state.documentId + 1,
  });
}

async function testStatusBarUi(): Promise<void> {
  // 先回到「没有文档」的状态，确认空态文案
  setDocument("", null);
  await frame();
  const emptyText = statusText();
  record(
    "空文档时左半边显示「就绪」且不显示字数",
    emptyText.startsWith("就绪") && !emptyText.includes("字数"),
    emptyText,
  );

  setDocument(DOC, "D:/notes/状态栏用例.md");
  await frame();

  const text = statusText();
  record("状态栏已挂载在页面里（footer 存在）", text.length > 0, text);
  // "abc\ndef" → abc 1 词 + def 1 词 = 2；字符 7（含换行）；行 2
  record(
    "字数与度量函数一致：abc\\ndef → 字数 2",
    text.includes("字数 2"),
    text,
  );
  record("字符数正确：字符 7", text.includes("字符 7"), text);
  record("行数正确：行 2", text.includes("行 2"), text);
  record("编码文案：UTF-8", text.includes("UTF-8"), text);
  record("换行符文案：LF", text.includes("LF"), text);

  // 视图模式文案跟随 store
  useEditor.getState().setViewMode("source");
  await frame();
  record("切源码模式后状态栏显示「源码」", statusText().includes("源码"), statusText());
  useEditor.getState().setViewMode("live");
  await frame();
  record("切回实时预览后显示「实时预览」", statusText().includes("实时预览"), statusText());
}

/**
 * 光标同步。
 *
 * 这是本批次最容易悄悄坏掉的一环：状态栏不读 store，而是自己订阅
 * `selectionchange`。如果 CM 改选区时不触发这个 DOM 事件，断言就会失败 ——
 * 而失败现象只是"光标位置一直不更新"，没有报错，很容易被忽略。
 */
async function testCursorSync(): Promise<void> {
  setDocument(DOC, "D:/notes/状态栏用例.md");
  await frame();
  await frame();

  const view = getActiveEditorView();
  if (!view) {
    record("能拿到编辑器视图（光标同步的前提）", false, "getActiveEditorView() 返回 null");
    return;
  }
  record("能拿到编辑器视图（光标同步的前提）", true);

  // 第 1 行选 2 个字符：anchor 0 → head 2
  view.dispatch({ selection: { anchor: 0, head: 2 } });
  await frame();
  await frame();
  let text = statusText();
  record("拖选后光标位置更新：行 1 列 3", text.includes("行 1 列 3"), text);
  record("拖选后显示已选字符数：已选 2", text.includes("已选 2"), text);

  // 第 2 行：head 6 → 行 2 列 3
  view.dispatch({ selection: { anchor: 6, head: 6 } });
  await frame();
  await frame();
  text = statusText();
  record("跨行移动光标：行 2 列 3", text.includes("行 2 列 3"), text);
  record("无选区时不显示「已选」", !text.includes("已选"), text);
}

// ------------------------------------------------------------ 3. 窗口标题

async function testWindowTitle(): Promise<void> {
  setDocument("", null);
  await frame();
  record(
    "未打开文档时标题为「未命名文档 — MD阅读器」",
    document.title === "未命名文档 — MD阅读器",
    document.title,
  );

  setDocument("正文", "D:/notes/示例.md");
  await frame();
  record("打开文档后标题带文件名", document.title === "示例.md — MD阅读器", document.title);

  useEditor.getState().setContent("改过的正文");
  await frame();
  record("有未保存改动时标题前加 ●", document.title === "● 示例.md — MD阅读器", document.title);

  useEditor.setState({ savedContent: "改过的正文" });
  await frame();
  record("保存后 ● 消失", document.title === "示例.md — MD阅读器", document.title);

  // Windows 反斜杠路径也要能取出文件名
  setDocument("正文", "D:\\code\\AI_Code\\MD阅读器\\dev\\反斜杠.md");
  await frame();
  record(
    "反斜杠路径也能取出文件名",
    document.title === "反斜杠.md — MD阅读器",
    document.title,
  );
}

// ------------------------------------------------------------ 收尾

function finish(): void {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;

  const lines = [
    ...results.map(
      (r, i) =>
        `${r.pass ? "PASS" : "FAIL"} ${String(i + 1).padStart(2, "0")} ${r.name}${r.info ? ` | ${r.info}` : ""}`,
    ),
    "",
    `STEPS ${steps.join(" → ")}`,
    "",
    `SUMMARY pass=${pass} fail=${fail} total=${results.length}`,
  ];

  const out = document.createElement("pre");
  out.id = "out";
  out.style.cssText = "position:fixed;left:0;bottom:0;z-index:9999;font-size:12px;white-space:pre-wrap";
  out.textContent = lines.join("\n");
  document.body.append(out);
  document.title = fail === 0 ? `ALL_PASS ${pass}/${results.length}` : `HAS_FAILURES ${fail}`;
}

setTimeout(() => finish(), 75000);

async function main(): Promise<void> {
  try {
    step("mountApp");
    createRoot(document.getElementById("root") ?? document.body).render(<App />);
    // 等 App 与 Editor 挂载完（Editor 挂载后 activeView 才不是 null）
    for (let i = 0; i < 60 && !document.querySelector(".cm-editor"); i += 1) await sleep(50);
    step("testMetrics");
    testMetrics();
    step("testStatusBarUi");
    await testStatusBarUi();
    step("testCursorSync");
    await testCursorSync();
    step("testWindowTitle");
    await testWindowTitle();
    step("done");
  } catch (err) {
    record("验收脚本自身异常", false, String(err));
    console.error(err);
  }

  finish();
}

void main();
