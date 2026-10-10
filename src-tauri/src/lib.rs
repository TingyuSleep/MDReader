//! 应用入口。
//!
//! 所有磁盘操作收敛到 `commands::file` 里，前端通过 invoke 调用；
//! 启动参数（文件关联带进来的路径）在 `commands::launch`。

mod commands;

use std::sync::Mutex;

use commands::launch::{
    emit_open_file, markdown_path_from_args, take_pending_open_path, PendingOpen,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
      冷启动时命令行里的文件路径。

      ⚠ 必须在 Builder 之前解析出来 —— 一旦 .run() 开始，前端可能在任意时刻挂载并发起请求，
      那时候再去读 argv 就晚了。
      这里只是把路径存起来，真正的打开动作由前端挂载后主动取走（见 commands::launch 的说明）。
    */
    let pending = markdown_path_from_args(std::env::args());

    tauri::Builder::default()
        /*
          单实例插件必须**第一个**注册（官方要求）。

          没有它的话：应用已经开着，再双击一个 .md 会拉起第二个进程、开出第二个窗口，
          两个窗口各改各的，最后互相覆盖 —— 这是数据丢失级别的体验问题，不是小瑕疵。
          装上之后第二个进程会被拦下，argv 转发给第一个实例，由我们 emit 事件让前端去打开。
        */
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = markdown_path_from_args(argv.iter()) {
                emit_open_file(app, path);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen(Mutex::new(pending)))
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::path_exists,
            commands::file::allow_asset_dir,
            take_pending_open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
