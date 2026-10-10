/**
 * Markdown 里的**路径**处理。纯字符串运算，没有任何运行时依赖。
 *
 * 为什么单独一个文件：
 *   解析模块（markdown-parse，跑在 Worker 里）要判断图片是不是「可直接加载的 URL」，
 *   清洗模块（markdown-sanitize，跑在主线程）要把 data-md-src 解析成绝对路径。
 *   两边都要这些函数，但它们本身跟 markdown-it / highlight.js / DOMPurify 全都无关。
 *   放在这里，就不会有人为了用 resolveRelativePath 而把 217KB 的解析器拖进主线程。
 *
 * 本应用只跑 Windows，所以「反斜杠是分隔符」是前提而非猜测。
 */

/** 反斜杠 → 正斜杠。Windows 下 `images\sub\a.png` 是很常见的写法，不转会拼出混血路径。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 折叠路径里的 `.` 与 `..`。注意 `..` 在根目录不再上溯，避免把 `C:/` 变成空串。 */
export function normalizeSegments(input: string): string {
  const drive = /^([a-zA-Z]:)/.exec(input)?.[1] ?? "";
  const rest = drive ? input.slice(drive.length) : input;
  const absolute = rest.startsWith("/");
  const segments: string[] = [];

  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `${drive}${absolute ? "/" : ""}${segments.join("/")}`;
}

/**
 * 相对路径 → 绝对路径。
 *
 * markdown-it 会对链接/图片地址做 normalizeLink（即 URL 编码），
 * 所以 `images/我的 图.png` 到这里已经是 `images/我的%20图.png`，需要先解码。
 *
 * 导出是为了让「图片能不能正确找到」这条逻辑可以被单独验证
 * （它跟 DOM、跟 Tauri 都无关，纯字符串）。
 */
export function resolveRelativePath(baseDir: string, raw: string): string {
  let src = raw.trim();
  try {
    src = decodeURIComponent(src);
  } catch {
    // 文件名里带裸 % 时 decode 会抛，保持原样即可
  }

  src = toPosix(src);

  // 已经是绝对路径，原样返回
  if (/^[a-zA-Z]:\//.test(src)) return src;

  const base = toPosix(baseDir).replace(/\/+$/, "");

  // `/images/a.png`：相对的是「当前盘符根」，不是当前目录
  if (src.startsWith("/")) {
    const drive = /^([a-zA-Z]:)/.exec(base)?.[1] ?? "";
    return normalizeSegments(`${drive}${src}`);
  }

  return normalizeSegments(`${base}/${src}`);
}

/**
 * 写进 data-md-src 的路径，是否本身就是可直接加载的 URL。
 *
 * 返回 false 的（相对路径、盘符路径、根路径）一律先不写 src，
 * 交给 resolveAssetImages() 在主线程按文档目录解析。
 */
export function isDirectlyLoadable(rawSrc: string): boolean {
  if (!rawSrc) return false;
  // Windows 盘符路径优先判断：`C:\a.png` 也能被通用协议正则匹配成「C:」，必须先拦掉
  if (/^[a-zA-Z]:[\\/]/.test(rawSrc)) return false;
  // 以 / 或 \ 开头：按文档所在盘符解析，交给主线程处理
  if (/^[\\/]/.test(rawSrc)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rawSrc);
}
