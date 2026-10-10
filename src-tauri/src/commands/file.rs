//! 文件读写 command。
//!
//! 三条设计原则：
//! 1. **读不改写** —— 探测 BOM 与换行风格后原样返回，不替用户规范化文件。
//! 2. **写有闸门** —— 内容与磁盘完全一致时直接返回 `written: false`，不碰文件时间戳。
//! 3. **错有出处** —— 所有失败都归一成带 `code` 的 `AppError`，不静默吞掉。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];

// ---------------------------------------------------------------- 错误

/// 统一错误结构。前端按 `code` 分支处理，`detail` 只用于日志/调试。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl AppError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }

    fn with_detail(code: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail: Some(detail.into()),
        }
    }

    /// 按 io::ErrorKind 归类，让前端能区分"文件没了"和"没权限"
    fn from_io(err: std::io::Error, path: &Path, action: &str) -> Self {
        use std::io::ErrorKind;
        let message = format!("{action}失败：{}", path.display());
        let detail = err.to_string();
        match err.kind() {
            ErrorKind::NotFound => Self::with_detail("NOT_FOUND", message, detail),
            ErrorKind::PermissionDenied => Self::with_detail("PERMISSION_DENIED", message, detail),
            _ => Self::with_detail("IO", message, detail),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

// ---------------------------------------------------------------- 返回值

/// `read_file` 的返回值
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    /// "utf-8" | "utf-8-bom"
    pub encoding: String,
    /// "lf" | "crlf" | "cr"
    pub eol: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub has_bom: bool,
}

/// `write_file` 的返回值
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    /// false = 内容没变，已跳过写入
    pub written: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

// ---------------------------------------------------------------- 内部工具

/// 统一入口：空路径直接拒掉，相对路径补成绝对路径
fn absolute(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("INVALID_PATH", "路径为空"));
    }
    let p = PathBuf::from(trimmed);
    if p.is_absolute() {
        return Ok(p);
    }
    std::env::current_dir()
        .map(|dir| dir.join(&p))
        .map_err(|e| AppError::with_detail("IO", "解析相对路径失败", e.to_string()))
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
}

fn detect_eol(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "crlf"
    } else if text.contains('\r') {
        "cr"
    } else {
        "lf"
    }
}

/// 原始字节 → 字符串。
///
/// MVP 只接受 UTF-8 与 UTF-8 BOM，其余编码走 `NOT_UTF8` 分流，
/// 由前端提示用户"暂不支持该编码"，而不是打开出一堆乱码。
///
/// TODO(v2): 接入 encoding_rs + chardetng 做旧编码嗅探（GBK / GB2312 / Big5 …）。
///           届时此处返回 `(String, TextEncoding)`，`encoding` 字段即可扩展。
fn decode(bytes: &[u8]) -> AppResult<(String, bool)> {
    let has_bom = bytes.starts_with(&BOM_UTF8);
    let body = if has_bom {
        &bytes[BOM_UTF8.len()..]
    } else {
        bytes
    };
    match std::str::from_utf8(body) {
        Ok(text) => Ok((text.to_owned(), has_bom)),
        Err(err) => Err(AppError::with_detail(
            "NOT_UTF8",
            "文件不是 UTF-8 编码，暂不支持打开",
            format!("首个非法字节位于 offset {}", err.valid_up_to()),
        )),
    }
}

/// 按原样写回：原本带 BOM 的补回 BOM，避免"存一次格式就变了"
fn encode(content: &str, with_bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + BOM_UTF8.len());
    if with_bom {
        out.extend_from_slice(&BOM_UTF8);
    }
    out.extend_from_slice(content.as_bytes());
    out
}

// ---------------------------------------------------------------- commands

/// 读取文件，返回内容 + 编码/换行等元信息
#[tauri::command]
pub fn read_file(path: String) -> AppResult<FileContent> {
    let abs = absolute(&path)?;
    let bytes = fs::read(&abs).map_err(|e| AppError::from_io(e, &abs, "读取文件"))?;
    let (content, has_bom) = decode(&bytes)?;
    let meta = fs::metadata(&abs).map_err(|e| AppError::from_io(e, &abs, "读取文件信息"))?;

    Ok(FileContent {
        path: abs.to_string_lossy().into_owned(),
        eol: detect_eol(&content).to_owned(),
        encoding: if has_bom { "utf-8-bom" } else { "utf-8" }.to_owned(),
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        has_bom,
        content,
    })
}

/// 写入文件。内容未变则跳过，保证同内容重复 Ctrl+S 不会刷新时间戳。
#[tauri::command]
pub fn write_file(path: String, content: String) -> AppResult<SaveResult> {
    let abs = absolute(&path)?;

    // 已存在的文件：先比对，一致就直接返回
    let mut with_bom = false;
    if let Ok(existing) = fs::read(&abs) {
        let (old_text, old_bom) = decode(&existing)?;
        with_bom = old_bom;
        if old_text == content {
            let meta =
                fs::metadata(&abs).map_err(|e| AppError::from_io(e, &abs, "读取文件信息"))?;
            return Ok(SaveResult {
                path: abs.to_string_lossy().into_owned(),
                written: false,
                size: meta.len(),
                modified_ms: modified_ms(&meta),
            });
        }
    }

    let bytes = encode(&content, with_bom);
    fs::write(&abs, &bytes).map_err(|e| AppError::from_io(e, &abs, "写入文件"))?;
    let meta = fs::metadata(&abs).map_err(|e| AppError::from_io(e, &abs, "读取文件信息"))?;

    Ok(SaveResult {
        path: abs.to_string_lossy().into_owned(),
        written: true,
        size: meta.len(),
        modified_ms: modified_ms(&meta),
    })
}

/// 路径是否存在。查询类操作，失败一律当 false，不打断 UI。
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 把某个目录注册进 asset protocol 白名单。
///
/// WebView 出于安全默认无法加载本地文件，Markdown 里的 `![](./images/a.png)`
/// 需要先放行所在目录，再用 `convertFileSrc()` 生成 `asset://` URL 才能显示。
/// 打开文档后调用一次即可，同目录重复调用是幂等的。
#[tauri::command]
pub fn allow_asset_dir(app: AppHandle, dir: String) -> AppResult<()> {
    let abs = absolute(&dir)?;
    app.asset_protocol_scope()
        .allow_directory(&abs, true)
        .map_err(|e| AppError::with_detail("IO", "注册图片访问目录失败", e.to_string()))
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独占一个文件名，避免并行测试互相覆盖
    fn temp_file(name: &str) -> String {
        let dir = std::env::temp_dir().join("md-reader-tests");
        fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir.join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn repeated_save_with_same_content_does_not_touch_file() {
        let path = temp_file("idempotent.md");

        let first = write_file(path.clone(), "# 标题\n".into()).expect("首次写入失败");
        assert!(first.written, "首次写入应真的落盘");

        let second = write_file(path.clone(), "# 标题\n".into()).expect("二次写入失败");
        assert!(!second.written, "内容没变时不应重复写盘");
        assert_eq!(
            first.modified_ms, second.modified_ms,
            "跳过写入时文件时间戳必须保持不变"
        );

        let third = write_file(path.clone(), "# 标题改过了\n".into()).expect("三次写入失败");
        assert!(third.written, "内容变了应重新写入");
    }

    #[test]
    fn bom_is_preserved_on_round_trip() {
        let path = temp_file("bom.md");

        let mut raw = BOM_UTF8.to_vec();
        raw.extend_from_slice("带 BOM 的内容".as_bytes());
        fs::write(&path, raw).expect("准备 BOM 文件失败");

        let read = read_file(path.clone()).expect("读取失败");
        assert_eq!(read.encoding, "utf-8-bom");
        assert!(read.has_bom);
        assert_eq!(read.content, "带 BOM 的内容", "返回内容应已剥离 BOM");

        write_file(path.clone(), "改过之后".into()).expect("写入失败");
        let after = fs::read(&path).expect("回读失败");
        assert!(after.starts_with(&BOM_UTF8), "原本带 BOM，写回时必须补回");
        assert_eq!(&after[BOM_UTF8.len()..], "改过之后".as_bytes());
    }

    #[test]
    fn eol_style_is_detected() {
        let path = temp_file("eol.md");

        fs::write(&path, b"a\r\nb\r\n").unwrap();
        assert_eq!(read_file(path.clone()).unwrap().eol, "crlf");

        fs::write(&path, b"a\nb\n").unwrap();
        assert_eq!(read_file(path.clone()).unwrap().eol, "lf");

        fs::write(&path, b"a\rb\r").unwrap();
        assert_eq!(read_file(path.clone()).unwrap().eol, "cr");
    }

    #[test]
    fn non_utf8_file_is_rejected_with_code() {
        let path = temp_file("gbk.md");
        // GBK 编码的"中文"，在 UTF-8 下非法
        fs::write(&path, [0xD6, 0xD0, 0xCE, 0xC4]).expect("准备 GBK 文件失败");

        let err = read_file(path).expect_err("非 UTF-8 文件应当报错");
        assert_eq!(err.code, "NOT_UTF8", "错误码要能区分编码问题，供 v2 接 GBK 分流");
    }

    #[test]
    fn missing_file_reports_not_found() {
        let path = temp_file("definitely-missing.md");
        let _ = fs::remove_file(&path);

        let err = read_file(path).expect_err("不存在的文件应当报错");
        assert_eq!(err.code, "NOT_FOUND");
    }

    #[test]
    fn empty_path_is_rejected() {
        let err = read_file("   ".into()).expect_err("空路径应当报错");
        assert_eq!(err.code, "INVALID_PATH");
    }
}
