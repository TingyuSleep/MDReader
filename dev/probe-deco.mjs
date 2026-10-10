/**
 * 一次性探针（用完即删）：Decoration.set 对「mark 紧邻 replace」的容忍度。
 *
 * 背景：链接 `[文本](url)` 的装饰天生是 replace / mark / replace 交替排列 ——
 * `[` 和 `]` 要藏起来（replace），中间的文字要着色（mark），三者边界严丝合缝。
 * 装饰器那边是把所有 range 交给 Decoration.set(ranges, sort=true) 统一排序的，
 * 如果 RangeSetBuilder 不接受共享边界，链接文字就会**静默**丢掉 class
 * （不抛错，只是不生效 —— 最难查的那种）。
 *
 * 用法：node dev/probe-deco.mjs
 */
import { Decoration } from "@codemirror/view";

const repl = Decoration.replace({});
const mark = Decoration.mark({ class: "cm-md-link" });

const cases = {
  "replace|mark|replace（链接的真实形态）": [
    repl.range(46, 47),
    mark.range(47, 49),
    repl.range(49, 50),
  ],
  "mark|replace 相邻": [mark.range(0, 5), repl.range(5, 6)],
  "replace|mark 相邻": [repl.range(0, 1), mark.range(1, 5)],
  "两个 replace 顺次": [repl.range(0, 1), repl.range(1, 2)],
  "line 装饰 + replace 同起点": [
    Decoration.line({ class: "cm-md-h1" }).range(0),
    repl.range(0, 2),
  ],
};

for (const [name, ranges] of Object.entries(cases)) {
  try {
    const set = Decoration.set(ranges, true);
    const found = [];
    set.between(0, 1000, (from, to, value) => {
      found.push(`${from}-${to}:${value.spec?.class ?? "replace"}`);
    });
    const expected = ranges.length;
    console.log(`PASS ${name} | ${found.length}/${expected} → ${found.join(", ")}`);
  } catch (err) {
    console.log(`THROW ${name} | ${err.message}`);
  }
}
