/**
 * 一次性探针：打印 lezer-markdown(GFM) 对各类语法产出的**真实节点名**。
 *
 * 为什么需要它：写 Live Preview 装饰器必须按节点名分派（hide 掉 HeaderMark、
 * 把 TaskMarker 换成复选框……）。节点名不能靠猜，猜错了装饰器会静默不生效。
 *
 * 用法：node dev/dump-syntax-tree.mjs
 */
import { GFM, parser } from "@lezer/markdown";

const sample = [
  "# 一级标题",
  "",
  "正文有 **加粗**、*斜体*、~~删除线~~ 和 `行内代码`。",
  "",
  "一个 [链接](https://example.com/page) 和自动链接 https://tauri.app 。",
  "",
  "![图片替代文字](./img/a.png)",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "- 无序项 A",
  "- 无序项 B",
  "  - 嵌套项",
  "",
  "1. 有序项一",
  "2. 有序项二",
  "",
  "- [ ] 待办未完成",
  "- [x] 待办已完成",
  "",
  "---",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "缩进代码块：",
  "",
  "    indented code",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 1   | 2   |",
  "",
  "## 二级标题",
  "",
].join("\n");

const tree = parser.configure([GFM]).parse(sample);

const names = new Map();
const lines = [];

tree.iterate({
  enter(node) {
    names.set(node.name, (names.get(node.name) ?? 0) + 1);
    const text = sample.slice(node.from, node.to);
    const display = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    lines.push(
      `${"  ".repeat(0)}${node.name.padEnd(22)} [${String(node.from).padStart(4)},${String(node.to).padStart(4)}] ${JSON.stringify(display)}`,
    );
  },
});

console.log("=========== 节点名统计 ===========");
for (const [name, count] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(String(count).padStart(3), name);
}

console.log("\n=========== 前 60 条（按出现顺序）===========");
console.log(lines.slice(0, 60).join("\n"));
