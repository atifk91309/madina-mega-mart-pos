use tauri::{AppHandle, Manager};
use std::path::PathBuf;

// ---------- BACKUP: madina.db ko user ki chosen jagah pe copy karo ----------
#[tauri::command]
async fn backup_db(app: AppHandle) -> Result<String, String> {
    // 1. DB kahan hai?
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("madina.db");

    if !db_path.exists() {
        return Err("madina.db nahi mili".into());
    }

    // 2. User se jagah pucho - Dialog plugin v2 ka sahi tareeqa
    let dest = tauri_plugin_dialog::DialogExt::dialog(&app)
        .file() // 👈 Ye line missing thi - isi se error aa raha tha
        .set_file_name(format!(
            "madina-backup-{}.db",
            chrono_lite_now()
        ))
        .add_filter("Database", &["db"])
        .blocking_save_file(); // 👈 pick_file nahi, save_file hai

    let dest = match dest {
        Some(f) => f.as_path().map(|p| p.to_path_buf()).ok_or("Path nahi mili".to_string())?,
        None => return Err("Cancelled".into()),
    };

    // 3. WAL checkpoint pehle - warna backup adhoora hoga
    // plugin-sql ka connection WAL me hai, is liye copy se pehle
    // frontend se `PRAGMA wal_checkpoint(TRUNCATE)` chala lena
    std::fs::copy(&db_path, &dest).map_err(|e| e.to_string())?;

    // -wal / -shm bhi hon to saath copy karo (safety)
    for suffix in ["-wal", "-shm"] {
        let extra = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if extra.exists() {
            let dest_extra = PathBuf::from(format!("{}{}", dest.display(), suffix));
            let _ = std::fs::copy(&extra, &dest_extra);
        }
    }

    Ok(dest.display().to_string())
}

fn chrono_lite_now() -> String {
    // chrono add kiye baghair simple timestamp: 1763577600 jaisa
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

// ---------- APP INFO: frontend ko bataye ga DB kahan hai ----------
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
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 👇 Yehi tumhara 80mm print fix karega - window.print() nahi
        .plugin(tauri_plugin_printer::init())
        .invoke_handler(tauri::generate_handler![backup_db, get_app_info])
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