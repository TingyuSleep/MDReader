/**
 * 端口探针（dev-only，用完即删）。
 *
 * 目的：判定 release exe 到底是从内嵌资源加载前端，还是去连 devUrl。
 *   - 若 exe 处于 dev 模式 → 它会来请求本服务的 `/`，日志里就会出现记录
 *   - 若 exe 处于生产模式 → 资源在编译期内嵌，一个请求都不会有
 *
 * 比 grep 二进制可靠得多：Tauri 会把整个 config（含 devUrl 字段）内嵌进 exe，
 * 所以「exe 里有没有 localhost:1420 这个字符串」永远为真，区分不了两种模式。
 *
 * 用法：node dev/port-probe.mjs [port] [logFile]
 */
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 1420);
const LOG = process.argv[3] ?? "dev/port-probe.log";

// 每次启动覆盖旧日志，避免上一轮的记录混淆判断
writeFileSync(LOG, "", "utf8");

const server = createServer((req, res) => {
  appendFileSync(
    LOG,
    `HIT ${new Date().toISOString()} ${req.method} ${req.url} ua=${req.headers["user-agent"] ?? "-"}\n`,
    "utf8",
  );
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><body><h1>PROBE SERVER</h1></body></html>");
});

server.listen(PORT, () => {
  appendFileSync(LOG, `LISTENING ${new Date().toISOString()} port=${PORT}\n`, "utf8");
  console.log(`[probe] 监听 ${PORT}，日志写入 ${LOG}`);
});
