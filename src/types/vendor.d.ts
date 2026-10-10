/**
 * 第三方包的补齐声明。
 *
 * 本文件必须是「全局脚本」形式 —— 内部不能出现顶层的 import / export，
 * 否则 `declare module` 会退化成模块增强，TS 会报
 * "Invalid module name in augmentation, module 'xxx' cannot be found"。
 */

/**
 * markdown-it-task-lists 2.1.1 是纯 JS、无任何类型声明，
 * DefinitelyTyped 上也没有对应包，只能自己补。
 *
 * 另外要注意：该插件的选项存在**模块级共享变量**里
 * （源码顶部就是 `var disableCheckboxes = true` 那几行），
 * 所以同一个进程里每次 use() 都必须传相同选项，否则会互相干扰。
 * 本应用固定传 { enabled: false }，保持预览区只读。
 */
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  export interface TaskListsOptions {
    /** true = 复选框可点击；本应用预览只读，固定 false */
    enabled?: boolean;
    /** 用 <label> 包裹复选框 */
    label?: boolean;
    /** 把 label 放到复选框之后 */
    labelAfter?: boolean;
  }

  const taskLists: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default taskLists;
}
