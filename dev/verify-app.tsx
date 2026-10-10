/**
 * 批次 4 / 5 的临时验收脚本：验证「工具栏 + 欢迎页 + 查找替换 + 应用外壳」。
 *
 * 挂载的是**真正的 <App/>**，不是拼出来的零件 —— 这一轮的价值就在于验证
 * 各部件接起来之后还成立。用完即删。
 *
 * 浏览器里没有 Tauri 运行时，所以：
 *   - 文件对话框走不到（pickMarkdownFile 直接返回 null）
 *   - 丢弃确认返回 "unsupported"，正好用来验「挡下并提示」这条分支
 *   - 打开文档靠直接写 store 模拟（真实 open() 要 invoke）
 */
// 验收构建没有 index.html 入口，必须显式引主题，否则 --* 令牌全未定义
import "@/index.css";

import { undo } from "@codemirror/commands";
import { createRoot } from "react-dom/client";

import App, { pickFirstMarkdown } from "@/App";
import { collectMatches } from "@/components/FindReplace";
import { getActiveEditorView, hasActiveEditorView } from "@/components/Editor";
import { dropRecentFile, loadRecentFiles, pushRecentFile, saveRecentFiles } from "@/lib/recent";
import {
  cycleThemeMode,
  getResolvedTheme,
  getThemeMode,
  setThemeMode,
  type ThemeMode,
} from "@/hooks/useTheme";
import { useEditor } from "@/store/editor";

// ------------------------------------------------------------ 骨架

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

const steps: string[] = [];
(window as unknown as Record<string, unknown>).__verifySteps = steps;
const t0 = performance.now();
const step = (name: string): void => {
  steps.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${name}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(15);
  }
  return predicate();
}

(window as unknown as Record<string, unknown>).__verifySnapshot = () => {
  const s = useEditor.getState();
  return {
    path: s.path,
    contentLength: s.content.length,
    viewMode: s.viewMode,
    recentCount: s.recentFiles.length,
    themeMode: getThemeMode(),
    hasToolbar: !!document.querySelector("header"),
    hasWelcome: !!document.querySelector("h1"),
    hasFindPanel: !!document.querySelector('[aria-label="查找与替换"]'),
    hasEditor: !!document.querySelector(".cm-editor"),
    /** 实时预览模式：标记被装饰器藏起来了 */
    hasLivePreview: !!document.querySelector(".cm-editor.cm-live-preview"),
    /** 源码模式：标记原样显示 */
    hasSourceMode: !!document.querySelector(".cm-editor.cm-source-mode"),
    notice: s.notice,
    error: s.error?.message ?? null,
  };
};

// ------------------------------------------------------------ DOM 小工具

const $ = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

/** 按 title 前缀点按钮。图标按钮没有文字，title 是最稳的定位方式。 */
function clickByTitle(prefix: string): boolean {
  const target = [...document.querySelectorAll<HTMLElement>("button[title]")].find((b) =>
    (b.getAttribute("title") ?? "").startsWith(prefix),
  );
  if (!target) return false;
  target.click();
  return true;
}

/** React 是受控输入，必须走原生 setter 再派发 input 事件，直接改 .value 它收不到 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(key: string, options: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

/** 模拟「已经打开了某个文档」。真实 open() 需要 Tauri invoke，浏览器里走不通。 */
async function fakeOpenDocument(text: string, path: string | null): Promise<void> {
  const state = useEditor.getState();
  useEditor.setState({
    path,
    content: text,
    savedContent: text,
    documentId: state.documentId + 1,
    error: null,
    notice: null,
  });
  // 等 Editor 的 documentId effect 把 doc 换掉
  await waitUntil(() => {
    const view = getActiveEditorView();
    return view !== null && view.state.doc.toString() === text;
  }, 2000);
}

// ------------------------------------------------------------ 装配

function mountApp(): void {
  const root = document.createElement("div");
  root.id = "app-host";
  // 给一个确定高度：App 根节点是 h-full，宿主没有高度就全塌成 0
  root.style.cssText = "position:fixed;inset:0;height:640px;width:1200px;overflow:hidden";
  document.body.append(root);
  createRoot(root).render(<App />);
}

// ------------------------------------------------------------ 1. 外壳与欢迎页

async function testShellAndWelcome(): Promise<void> {
  // 从「什么都没打开」的干净状态起步
  useEditor.setState({ path: null, content: "", savedContent: "", recentFiles: [], notice: null, error: null });
  await sleep(120);

  record("工具栏已挂载", !!$("header"), $("header")?.className.split(" ")[0] ?? "");
  record("工具栏含打开按钮", !!$('button[aria-label="打开"]'));
  record("工具栏含保存按钮", !!$('button[aria-label="保存"]'));
  record("工具栏含另存为按钮", !!$('button[aria-label="另存为"]'));
  record(
    "工具栏含两个视图选项",
    document.querySelectorAll('[aria-label="视图模式"] button').length === 2,
    `${document.querySelectorAll('[aria-label="视图模式"] button').length} 个`,
  );
  record("工具栏含主题按钮", !!$('button[title^="主题："]'));

  record(
    "无文档时展示欢迎页",
    !!$("h1") && ($("h1")?.textContent ?? "").includes("MD阅读器"),
  );

  // 最近文件为空时的空态
  record(
    "最近文件为空时给出空态文案",
    (document.body.textContent ?? "").includes("还没有记录"),
  );
}

async function testWelcomeRecentList(): Promise<void> {
  useEditor.setState({ recentFiles: ["D:/docs/alpha.md", "D:/docs/beta.md"] });
  await sleep(80);

  const items = [...document.querySelectorAll<HTMLElement>("li button[title]")].filter((b) =>
    (b.getAttribute("title") ?? "").startsWith("D:/docs/"),
  );
  record("欢迎页渲染最近文件条目", items.length === 2, `${items.length} 条`);
  record(
    "最近文件同时显示文件名与目录",
    (items[0]?.textContent ?? "").includes("alpha.md") &&
      (items[0]?.textContent ?? "").includes("D:/docs"),
    items[0]?.textContent ?? "",
  );

  // tooltip 必须在移除之前查——点完这条就没了
  record(
    "移除按钮的 tooltip 指名了具体文件",
    [...document.querySelectorAll("button[title]")].some((b) =>
      (b.getAttribute("title") ?? "").includes("alpha.md"),
    ),
  );

  const before = useEditor.getState().recentFiles.length;
  const removed = clickByTitle("从最近列表移除");
  await sleep(60);
  record(
    "移除按钮生效",
    removed && useEditor.getState().recentFiles.length === before - 1,
    `点击命中=${removed}，${before} → ${useEditor.getState().recentFiles.length} 条`,
  );
  record(
    "被移除的路径不在列表里",
    !useEditor.getState().recentFiles.includes("D:/docs/alpha.md"),
  );
}

// ------------------------------------------------------------ 2. 视图模式（实时预览 / 源码）

/**
 * 测试文档刻意**把标题放在第三行**。
 *
 * CodeMirror 新建 EditorState 时光标在位置 0，而块级标记是按行豁免的 ——
 * 第一行若是标题，`#` 一打开就是显形状态，断言会莫名其妙地失败。
 * 让首行是普通段落，标题才能真的测到「藏起来了」。
 *
 * 覆盖三种块级结构（标题 / 引用 / 表格 / 代码块）、四种行内结构（加粗 / 斜体 / 行内代码 / 链接），
 * 外加两种 widget（项目符号 / 任务复选框）。
 */
const LIVE_DOC = [
  "开头一段普通文字。",
  "",
  "# 一级标题",
  "",
  "这是 **加粗** 和 *斜体* 和 `代码` 和 [链接](https://example.com)。",
  "",
  "- 项目 A",
  "- [ ] 待办事项",
  "",
  "> 引用文字",
  "",
  "| 名称 | 值 |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
].join("\n");

/** 编辑区此刻真正渲染出来的文本 */
const contentText = (): string => $(".cm-content")?.textContent ?? "";

/** 等装饰层把语法树解析完并挂上 —— 首帧树还没解析完，装饰是空的 */
async function waitForDecorations(): Promise<void> {
  await waitUntil(() => document.querySelectorAll(".cm-line.cm-md-h1").length > 0, 3000);
}

async function testViewModes(): Promise<void> {
  useEditor.getState().setViewMode("live");
  await fakeOpenDocument(LIVE_DOC, "D:/docs/live.md");
  await waitForDecorations();

  record("打开文档后欢迎页消失", !document.querySelector("h1"));
  record("实时预览模式挂在 .cm-editor 上", !!$(".cm-editor.cm-live-preview"));
  // Typora 也没有行号；live 模式下正文居中，左边再挂一条 gutter 会把排版挤偏
  record("实时预览模式不显示行号", !$(".cm-gutters"));

  // ---- 块级装饰
  record("标题行带上 cm-md-h1", document.querySelectorAll(".cm-line.cm-md-h1").length === 1);
  record("引用行带上 cm-md-quote", document.querySelectorAll(".cm-line.cm-md-quote").length === 1);
  const codeLines = document.querySelectorAll(".cm-line.cm-md-codeblock").length;
  record("代码块三行都带上 cm-md-codeblock", codeLines === 3, `${codeLines} 行`);
  const tableLines = document.querySelectorAll(".cm-line.cm-md-table").length;
  record("表格三行都带上 cm-md-table", tableLines === 3, `${tableLines} 行`);
  record(
    "表格分隔行被单独弱化",
    document.querySelectorAll(".cm-line.cm-md-table-delim").length === 1,
  );

  // ---- 行内装饰与 widget
  const bullet = $(".cm-md-bullet");
  record("无序列表换成项目符号", bullet?.textContent === "•", bullet?.textContent ?? "(无)");
  record("任务列表换成可点复选框", !!$<HTMLInputElement>("input.cm-md-task"));
  record("行内代码带上底色 class", !!$(".cm-md-inline-code"));
  record("链接文本带上链接 class", !!$(".cm-md-link"));

  // ---- 标记确实被藏了。这是 Live Preview 的立身之本，藏不掉就只是换了配色的源码编辑器。
  const text = contentText();
  record("加粗标记 ** 已隐藏", !text.includes("**"), text.slice(0, 50));
  record("行内代码标记已隐藏", !text.includes("`代码`"));
  record("链接地址已隐藏", !text.includes("https://example.com"));
  record("引用符号 > 已隐藏", !text.includes("> 引用"));
  record("标题的 # 已隐藏", !text.includes("# 一级标题"));
  // 藏标记不能连带把正文吃掉
  record(
    "正文内容完整保留",
    ["一级标题", "加粗", "斜体", "代码", "链接", "引用文字", "项目 A", "待办事项"].every((s) =>
      text.includes(s),
    ),
  );

  // ---- 行内标记按元素豁免：光标进了元素范围就得显形，否则没法改
  const view = getActiveEditorView();
  view?.dispatch({ selection: { anchor: LIVE_DOC.indexOf("**加粗**") + 3 } });
  await sleep(180);
  record(
    "光标进入加粗范围后 ** 显形",
    contentText().includes("**加粗**"),
    contentText().slice(0, 60),
  );

  // ---- 块级标记按行豁免：光标在标题行就整行显形
  view?.dispatch({ selection: { anchor: LIVE_DOC.indexOf("# 一级标题") + 4 } });
  await sleep(180);
  record("光标进入标题行后 # 显形", contentText().includes("# 一级标题"));

  // ---- 切到源码模式
  clickByTitle("源码");
  await sleep(280);
  record("源码模式挂在 .cm-editor 上", !!$(".cm-editor.cm-source-mode"));
  record("源码模式恢复行号", !!$(".cm-gutters"));
  const sourceText = contentText();
  record(
    "源码模式下所有标记原样可见",
    sourceText.includes("**加粗**") &&
      sourceText.includes("https://example.com") &&
      sourceText.includes("# 一级标题"),
  );
  record("视图模式已同步到 store", useEditor.getState().viewMode === "source");
  // 深色下「选中」是比容器更暗的底色，肉眼很难分，只能靠 aria-pressed 兜
  record(
    "工具栏按钮态跟随视图模式",
    $('[aria-label="源码"]')?.getAttribute("aria-pressed") === "true" &&
      $('[aria-label="实时预览"]')?.getAttribute("aria-pressed") === "false",
    `源码=${$('[aria-label="源码"]')?.getAttribute("aria-pressed")} 实时预览=${$('[aria-label="实时预览"]')?.getAttribute("aria-pressed")}`,
  );
  record("切模式后编辑视图仍连着（注册表没丢）", hasActiveEditorView());

  // ---- 切回实时预览：装饰要重新生成，内容不能被破坏
  clickByTitle("实时预览");
  await sleep(340);
  record(
    "切回实时预览后装饰重新生成",
    !!$(".cm-editor.cm-live-preview") && !!$(".cm-line.cm-md-h1"),
  );
  record("切回后标记重新隐藏", !contentText().includes("**"));
  record("切回后文档内容没被改动", useEditor.getState().content === LIVE_DOC);
}

// ------------------------------------------------------------ 3. 主题

function testTheme(): void {
  const root = document.documentElement;

  setThemeMode("light");
  record("浅色模式不挂 .dark", !root.classList.contains("dark"));

  setThemeMode("dark");
  record("深色模式挂上 .dark", root.classList.contains("dark"));
  record("主题偏好写入 localStorage", localStorage.getItem("md-reader.theme") === "dark");
  record("resolved 主题为 dark", getResolvedTheme() === "dark");

  // 三态循环：dark → system → light → dark
  const seen: ThemeMode[] = [getThemeMode()];
  for (let i = 0; i < 3; i += 1) {
    cycleThemeMode();
    seen.push(getThemeMode());
  }
  record(
    "主题三态循环顺序正确",
    JSON.stringify(seen) === JSON.stringify(["dark", "system", "light", "dark"]),
    seen.join(" → "),
  );

  setThemeMode("system");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  record(
    "跟随系统时 .dark 与系统偏好一致",
    root.classList.contains("dark") === systemDark,
    `系统偏好 ${systemDark ? "深色" : "浅色"}`,
  );
  note("主题", `三态为 light/dark/system，存储键 md-reader.theme，首屏由 public/theme-init.js 兜底`);

  // 收尾回到浅色，避免影响后面按钮颜色的断言
  setThemeMode("light");
}

// ------------------------------------------------------------ 4. 浏览器拖拽降级

async function testDragDropFallback(): Promise<void> {
  // 浏览器里拿不到 File 的绝对路径，应该明说而不是假装成功
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(["# hi"], "dropped.md", { type: "text/markdown" }));
  window.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
  );
  await sleep(60);

  const notice = useEditor.getState().notice ?? "";
  record(
    "浏览器拖拽给出明确提示而非静默",
    notice.includes("拖拽"),
    notice,
  );
  useEditor.setState({ notice: null });
}

// ------------------------------------------------------------ 5. 全局快捷键

async function testShortcuts(): Promise<void> {
  // ---- Ctrl+F 开面板 / Esc 关面板
  pressKey("f", { ctrlKey: true });
  await sleep(80);
  record("Ctrl+F 打开查找面板", !!$('[aria-label="查找与替换"]'));

  pressKey("Escape");
  await sleep(80);
  record("Esc 关闭查找面板", !$('[aria-label="查找与替换"]'));

  // ---- Ctrl+F 可反复切换（不是只开不关）
  pressKey("f", { ctrlKey: true });
  await sleep(50);
  pressKey("f", { ctrlKey: true });
  await sleep(50);
  record("Ctrl+F 再按一次可关闭", !$('[aria-label="查找与替换"]'));

  // ---- 有未保存改动时 Ctrl+N 必须被挡下
  const state = useEditor.getState();
  useEditor.setState({ content: `${state.content}\n新增一行`, notice: null });
  await sleep(60);

  pressKey("n", { ctrlKey: true });
  await sleep(150);

  const after = useEditor.getState();
  record(
    "有未保存改动时新建被挡下（不静默丢内容）",
    after.content.includes("新增一行") && (after.notice ?? "").includes("未保存"),
    after.notice ?? "(无提示)",
  );

  // ---- 无改动时 Ctrl+N 正常新建
  useEditor.setState({ savedContent: useEditor.getState().content, notice: null });
  await sleep(40);
  pressKey("n", { ctrlKey: true });
  await sleep(200);

  const cleared = useEditor.getState();
  record(
    "无未保存改动时 Ctrl+N 正常新建",
    cleared.content === "" && cleared.path === null,
    `content=${cleared.content.length} path=${cleared.path}`,
  );

  // ---- Esc 清理提示条
  useEditor.setState({ notice: "测试提示" });
  await sleep(60);
  pressKey("Escape");
  await sleep(60);
  record("Esc 可关闭提示条", useEditor.getState().notice === null);
}

// ------------------------------------------------------------ 6. 提示条渲染

async function testBannerRendering(): Promise<void> {
  useEditor.setState({
    notice: "这是一条普通提示",
    error: { code: "NOT_FOUND", message: "文件不存在", detail: "D:/docs/missing.md" },
  });
  await sleep(80);

  const alert = $('[role="alert"]');
  record("错误提示条渲染", !!alert && (alert.textContent ?? "").includes("文件不存在"));
  record(
    "错误提示条带出具体路径",
    (alert?.textContent ?? "").includes("D:/docs/missing.md"),
  );
  record(
    "普通提示条渲染",
    [...document.querySelectorAll('[role="status"]')].some((el) =>
      (el.textContent ?? "").includes("这是一条普通提示"),
    ),
  );

  useEditor.setState({ notice: null, error: null });
  await sleep(60);
  record("清空后提示条消失", !$('[role="alert"]'));
}

// ------------------------------------------------------------ 7. 查找匹配（纯函数）

function testMatcher(): void {
  const base = { regex: false, caseSensitive: false, wholeWord: false };

  const literal = collectMatches("foo foo FOO", "foo", base);
  record("普通文本：默认忽略大小写", literal.ranges.length === 3, `${literal.ranges.length} 条`);

  const sensitive = collectMatches("foo foo FOO", "foo", { ...base, caseSensitive: true });
  record("普通文本：区分大小写", sensitive.ranges.length === 2, `${sensitive.ranges.length} 条`);

  const whole = collectMatches("cat category cat", "cat", { ...base, wholeWord: true });
  record("全词匹配：category 内的 cat 不算", whole.ranges.length === 2, `${whole.ranges.length} 条`);

  const escaped = collectMatches("a.b axb a.b", "a.b", base);
  record(
    "普通文本模式不把 . 当通配符",
    escaped.ranges.length === 2,
    `${escaped.ranges.length} 条（点号已转义）`,
  );

  const re = collectMatches("a1 b2 c3", "\\d", { ...base, regex: true });
  record("正则模式命中 3 个数字", re.ranges.length === 3, `${re.ranges.length} 条`);

  const bad = collectMatches("abc", "(", { ...base, regex: true });
  record("非法正则给出错误而不是抛异常", bad.error !== null && bad.ranges.length === 0, bad.error ?? "(无)");

  // 零宽匹配必须能收敛：`a*` 在 "abc" 上只有 index 0 那次是非零宽的
  const zeroWidth = collectMatches("abc", "a*", { ...base, regex: true });
  record("零宽匹配不会死循环", zeroWidth.ranges.length === 1, `${zeroWidth.ranges.length} 条`);

  const many = collectMatches("x".repeat(6000), "x", base);
  record(
    "匹配数被上限截断并标记",
    many.truncated && many.ranges.length === 5000,
    `${many.ranges.length} 条 truncated=${many.truncated}`,
  );

  const empty = collectMatches("abc", "", base);
  record("空查询返回空结果", empty.ranges.length === 0 && empty.error === null);

  // 中文：普通文本模式下按码点匹配，不该被 \u 处理搞乱
  const cjk = collectMatches("中文中文abc中文", "中文", base);
  record("中文可正常匹配", cjk.ranges.length === 3, `${cjk.ranges.length} 条`);
}

// ------------------------------------------------------------ 8. 查找替换 UI

async function testFindReplaceUi(): Promise<void> {
  const source = "alpha beta alpha gamma alpha";
  await fakeOpenDocument(source, "D:/docs/find.md");
  await sleep(150);

  pressKey("f", { ctrlKey: true });
  await sleep(120);

  const panel = $('[aria-label="查找与替换"]');
  record("查找面板已显示", !!panel);

  const findInput = $<HTMLInputElement>('input[aria-label="查找"]');
  const replaceInput = $<HTMLInputElement>('input[aria-label="替换为"]');
  record("查找输入框存在", !!findInput);
  record("替换输入框默认收起", !replaceInput);

  setInputValue(findInput!, "alpha");
  await sleep(120);

  const counter = panel?.querySelector("span[title]");
  record(
    "计数器显示 1 / 3",
    (counter?.textContent ?? "").trim() === "1 / 3",
    (counter?.textContent ?? "").trim(),
  );

  // 输入即选中第一处，不用先点「下一个」
  const autoView = getActiveEditorView();
  record(
    "输入查询后自动选中第一处",
    autoView?.state.selection.main.from === 0 && autoView.state.selection.main.to === 5,
    `选区 ${autoView?.state.selection.main.from}–${autoView?.state.selection.main.to}`,
  );
  // 而且不能把焦点从查找框抢走，否则打字会断
  record(
    "自动选中不会抢走查找框焦点",
    document.activeElement === findInput,
    document.activeElement?.tagName ?? "(无)",
  );

  // 下一个：应把选区移到第二处并推进计数
  clickByTitle("下一个");
  await sleep(100);
  const view = getActiveEditorView();
  const second = source.indexOf("alpha", source.indexOf("alpha") + 1);
  record(
    "「下一个」把光标定位到第二处匹配",
    view?.state.selection.main.from === second,
    `from=${view?.state.selection.main.from} 期望=${second}`,
  );
  record(
    "计数器推进到 2 / 3",
    (counter?.textContent ?? "").trim() === "2 / 3",
    (counter?.textContent ?? "").trim(),
  );

  // 上一个：回到第一处
  clickByTitle("上一个");
  await sleep(100);
  record(
    "「上一个」回到第一处",
    getActiveEditorView()?.state.selection.main.from === 0,
    `from=${getActiveEditorView()?.state.selection.main.from}`,
  );

  // 展开替换行
  const toggle = [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
    (b.textContent ?? "").includes("显示替换"),
  );
  toggle?.click();
  await sleep(120);

  const replaceBox = $<HTMLInputElement>('input[aria-label="替换为"]');
  record("展开后出现替换输入框", !!replaceBox);

  setInputValue(replaceBox!, "OMEGA");
  await sleep(80);

  // ---- 替换全部：一次 Ctrl+Z 就能整体回退
  const replaced = clickByTitle("替换全部");
  await sleep(200);
  const afterAll = useEditor.getState().content;
  record(
    "全部替换生效",
    replaced && afterAll === "OMEGA beta OMEGA gamma OMEGA",
    afterAll,
  );

  const viewAfter = getActiveEditorView();
  if (viewAfter) undo(viewAfter);
  await sleep(150);
  record(
    "全部替换可一次撤销回退",
    useEditor.getState().content === source,
    useEditor.getState().content,
  );

  // ---- 替换当前：只替一处
  setInputValue($<HTMLInputElement>('input[aria-label="查找"]')!, "alpha");
  await sleep(100);
  clickByTitle("替换");
  await sleep(200);
  const afterOne = useEditor.getState().content;
  record(
    "替换当前只替一处",
    /^OMEGA beta alpha gamma alpha$/.test(afterOne),
    afterOne,
  );

  // ---- 非法正则要有可见错误
  const regexChip = document.querySelector<HTMLElement>('[aria-label="正则表达式"]');
  regexChip?.click();
  await sleep(80);
  setInputValue($<HTMLInputElement>('input[aria-label="查找"]')!, "(");
  await sleep(120);
  const counterText = panel?.querySelector("span[title]")?.textContent ?? "";
  record(
    "非法正则给出错误提示且不崩",
    counterText.includes("正则表达式无效"),
    counterText,
  );

  pressKey("Escape");
  await sleep(80);
  record("Esc 收起查找面板", !$('[aria-label="查找与替换"]'));
}

// ------------------------------------------------------------ 9. 最近文件持久化

function testRecentStorage(): void {
  const pushed = pushRecentFile(["b.md", "c.md"], "a.md");
  record(
    "pushRecentFile 插到队首",
    JSON.stringify(pushed) === JSON.stringify(["a.md", "b.md", "c.md"]),
    pushed.join(","),
  );

  const deduped = pushRecentFile(["a.md", "b.md"], "b.md");
  record(
    "pushRecentFile 去重且提到队首",
    JSON.stringify(deduped) === JSON.stringify(["b.md", "a.md"]),
    deduped.join(","),
  );

  const dropped = dropRecentFile(["a.md", "b.md"], "a.md");
  record("dropRecentFile 移除指定项", JSON.stringify(dropped) === JSON.stringify(["b.md"]));

  // 往返
  saveRecentFiles(["x.md", "y.md"]);
  record("saveRecentFiles 写入后可读回", JSON.stringify(loadRecentFiles()) === JSON.stringify(["x.md", "y.md"]));

  // 坏数据必须降级而不是抛错
  localStorage.setItem("md-reader.recent-files", "{ 这不是 JSON");
  record("损坏的 JSON 降级为空列表", loadRecentFiles().length === 0);

  localStorage.setItem("md-reader.recent-files", JSON.stringify([1, null, "ok.md", "ok.md", ""]));
  const sanitized = loadRecentFiles();
  record(
    "读取时会剔除非字符串与重复项",
    JSON.stringify(sanitized) === JSON.stringify(["ok.md"]),
    JSON.stringify(sanitized),
  );

  localStorage.removeItem("md-reader.recent-files");
}

// ------------------------------------------------------------ 10. 拖拽路径挑选

function testPickFirstMarkdown(): void {
  record("能从混合路径里挑出 md", pickFirstMarkdown(["a.txt", "b.md", "c.png"]) === "b.md");
  record("支持 .markdown 扩展名", pickFirstMarkdown(["a.markdown"]) === "a.markdown");
  record("大小写不敏感", pickFirstMarkdown(["A.MD"]) === "A.MD");
  record("没有 md 时返回 null", pickFirstMarkdown(["a.txt", "b.png"]) === null);
  record("空数组返回 null", pickFirstMarkdown([]) === null);
}

// ------------------------------------------------------------ 汇总

let finished = false;

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
  out.style.cssText = "position:fixed;left:0;bottom:0;z-index:9999;font-size:12px;white-space:pre-wrap";
  out.textContent = lines.join("\n");
  document.body.append(out);
  document.title = fail === 0 ? `ALL_PASS ${pass}/${results.length}` : `HAS_FAILURES ${fail}`;
}

setTimeout(() => finish("硬超时 75s"), 75000);

async function main(): Promise<void> {
  try {
    step("mountApp");
    mountApp();
    step("testShellAndWelcome");
    await testShellAndWelcome();
    step("testWelcomeRecentList");
    await testWelcomeRecentList();
    step("testViewModes");
    await testViewModes();
    step("testTheme");
    testTheme();
    step("testDragDropFallback");
    await testDragDropFallback();
    step("testShortcuts");
    await testShortcuts();
    step("testBannerRendering");
    await testBannerRendering();
    step("testMatcher");
    testMatcher();
    step("testFindReplaceUi");
    await testFindReplaceUi();
    step("testRecentStorage");
    testRecentStorage();
    step("testPickFirstMarkdown");
    testPickFirstMarkdown();
    step("done");
  } catch (err) {
    record("验收脚本自身异常", false, String(err));
    console.error(err);
  }

  finish();
}

void main();
