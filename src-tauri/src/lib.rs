use tauri::{AppHandle, Manager};
use tauri_plugin_sql::Builder;

mod license;

// ---------- LICENSE ----------
#[tauri::command]
fn get_my_machine_id() -> String {
    license::get_machine_id()
}

#[tauri::command]
fn verify_license(key: String) -> Result<String, String> {
    let mid = license::get_machine_id();
    license::check_license(&key, &mid)
} 

// ---------- BACKUP ----------
#[tauri::command]
async fn backup_db(app: AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("madina.db");

    if !db_path.exists() {
        return Err("madina.db nahi mili".into());
    }

    let dest = tauri_plugin_dialog::DialogExt::dialog(&app)
        .file()
        .set_file_name(format!("madina-backup-{}.db", chrono_lite_now()))
        .add_filter("Database", &["db"])
        .blocking_save_file();

    let dest = match dest {
        Some(f) => f.as_path().map(|p| p.to_path_buf()).ok_or("Path nahi mili".to_string())?,
        None => return Err("Cancelled".into()),
    };

    std::fs::copy(&db_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.display().to_string())
}

fn chrono_lite_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "appDataDir": dir.display().to_string(),
        "dbPath": dir.join("madina.db").display().to_string(),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            Builder::new()
                .build()
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_printer::init())
        // ✅ SINGLE INSTANCE - 2ri window na khule, pehli wali samne aa jaye
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            backup_db,
            get_app_info,
            get_my_machine_id,
            verify_license,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}