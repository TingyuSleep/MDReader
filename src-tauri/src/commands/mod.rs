//! Rust 侧命令模块。
//!
//! 约定：前端不直接碰 std::fs，所有磁盘操作都从这里出去。

pub mod file;
pub mod launch;
