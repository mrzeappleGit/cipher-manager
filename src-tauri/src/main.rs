// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--run-system-task") {
        let result = args.next().ok_or_else(|| "Missing task slug".to_string())
            .and_then(|slug| cipher_manager_lib::commands::run_system_task(&slug));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    cipher_manager_lib::run()
}
