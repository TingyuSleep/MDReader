//! 启动参数里带进来的「待打开文件」。
//!
//! 文件关联（双击 .md）之后有两条完全不同的来路，时机差得很远，必须分开处理：
//!
//! - **冷启动**：`md-reader.exe D:\notes\a.md`。
//!   此刻前端还没挂载、还没开始 `listen`，直接 emit 事件必然丢掉。
//!   所以先把路径存进 `PendingOpen`，等前端挂载后**主动调**
//!   `take_pending_open_path` 取走（取完即清，避免热重载时重复打开）。
//! - **应用已在运行**：双击第二个文件会拉起第二个进程，
//!   `tauri-plugin-single-instance` 把它拦下并把 argv 转发给第一个实例，
//!   这时前端一定已经在监听事件了，直接 emit `open-file` 即可。
//!
//! 为什么在这个文件里判断扩展名而不是交给前端：
//! 前端压根拿不到 argv —— 命令行参数只在 Rust 侧可见。

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

/// 冷启动时暂存的文件路径。前端取走之后置回 `None`。
#[derive(Default)]
pub struct PendingOpen(pub Mutex<Option<String>>);

/// 应用**已经在运行**时，第二次打开文件走这个事件。
pub const OPEN_FILE_EVENT: &str = "open-file";

/// 认识这两个扩展名，和 `src/lib/fs.ts` 的 `MARKDOWN_EXTENSIONS` 保持一致。
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];

/// 从一串命令行参数里挑出第一个 Markdown 文件。
///
/// 刻意**不**按位置跳过 argv[0]：不同平台、不同调用方对「argv 里含不含 exe 自身路径」
/// 的做法并不一致，按位置跳一旦猜错就会把真正的文件漏掉。
/// 改成按扩展名过滤就与位置无关了 —— exe 自己的扩展名是 `.exe`，天然不会命中。
pub fn markdown_path_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for arg in args {
        // Windows 上传进来的参数可能带着引号，去掉再判断
        let candidate = arg.as_ref().trim().trim_matches('"');
        if candidate.is_empty() || candidate.starts_with('-') {
            continue;
        }
        let matched = Path::new(candidate)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| MARKDOWN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()));
        if matched {
            return Some(candidate.to_string());
        }
    }
    None
}

/// 前端挂载后取一次冷启动带来的路径；**取完即清**。
#[tauri::command]
pub fn take_pending_open_path(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(err) => {
            // 锁中毒说明别处 panic 过。不能静默，否则表现为「双击文件没反应」这种最难查的症状。
            eprintln!("[launch] 待打开文件的状态锁已中毒：{err}");
            None
        }
    }
}

/// 把「第二次启动」带来的路径推给前端。
pub fn emit_open_file(app: &AppHandle, path: String) {
    if let Err(err) = app.emit(OPEN_FILE_EVENT, path) {
        eprintln!("[launch] 转发待打开文件失败：{err}");
    }
}

// ------------------------------------------------------------ 测试

#[cfg(test)]
mod tests {
    use super::markdown_path_from_args;

    #[test]
    fn 取第一个_markdown_文件() {
        let args = ["md-reader.exe", "D:\\a.md", "D:\\b.markdown"];
        assert_eq!(markdown_path_from_args(args).as_deref(), Some("D:\\a.md"));
    }

    /// argv[0] 是 exe 自身，绝不能当成文件打开
    #[test]
    fn 跳过_exe_自身的路径() {
        let args = ["C:\\Program Files\\MD阅读器\\md-reader.exe"];
        assert_eq!(markdown_path_from_args(args), None);
    }

    #[test]
    fn 跳过开关类参数() {
        let args = ["md-reader.exe", "--verbose", "-h", "D:\\notes\\a.md"];
        assert_eq!(markdown_path_from_args(args).as_deref(), Some("D:\\notes\\a.md"));
    }

    #[test]
    fn 去掉_windows_传来的引号() {
        let args = ["md-reader.exe", "\"D:\\我的 笔记\\a.md\""];
        assert_eq!(markdown_path_from_args(args).as_deref(), Some("D:\\我的 笔记\\a.md"));
    }

    #[test]
    fn 扩展名大小写不敏感() {
        assert_eq!(
            markdown_path_from_args(["x.exe", "D:\\A.MD"]).as_deref(),
            Some("D:\\A.MD")
        );
    }

    #[test]
    fn 非_markdown_一律不认() {
        assert_eq!(markdown_path_from_args(["x.exe", "D:\\a.txt", "D:\\b.pdf"]), None);
        assert_eq!(markdown_path_from_args(["x.exe"]), None);
        assert_eq!(markdown_path_from_args(Vec::<String>::new()), None);
    }

    /// `report.md.bak` 的扩展名是 `bak`，不该被当成 markdown
    #[test]
    fn 不误判多段扩展名() {
        assert_eq!(markdown_path_from_args(["x.exe", "D:\\report.md.bak"]), None);
    }
}
