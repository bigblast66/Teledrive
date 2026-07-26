// commands/encryption.rs
use crate::commands::TelegramState;
use crate::startup;
use tauri::{AppHandle, Manager, State};

/// Called once at app launch (after Telegram login succeeds) to decide
/// whether a password prompt is needed at all.
/// Returns "unlocked" | "locked" | "new".
#[tauri::command]
pub async fn cmd_check_encryption_status(app: AppHandle, state: State<'_, TelegramState>) -> Result<String, String> {
    let client = state.client.lock().await.clone()
        .ok_or_else(|| "Not connected to Telegram".to_string())?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    match startup::determine_startup_path(&client, &app_data_dir).await? {
        startup::StartupOutcome::UnlockedSilently(key) => {
            *state.encryption_key.lock().await = Some(key);
            Ok("unlocked".to_string())
        }
        startup::StartupOutcome::NeedsPasswordPrompt { .. } => Ok("locked".to_string()),
        startup::StartupOutcome::NeedsFirstTimeSetup => Ok("new".to_string()),
    }
}

/// Called when the user submits the password field, whether it's an
/// existing password (unlock) or a brand-new one (first-time setup).
/// Re-checks Telegram itself rather than relying on state stashed from the
/// status check above, keeping this a single self-contained call.
#[tauri::command]
pub async fn cmd_unlock(app: AppHandle, password: String, state: State<'_, TelegramState>) -> Result<(), String> {
    let client = state.client.lock().await.clone()
        .ok_or_else(|| "Not connected to Telegram".to_string())?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let key = match startup::fetch_remote_vault(&client).await {
        Some(vault) => startup::complete_unlock_with_password(&app_data_dir, &password, &vault)?,
        None => startup::complete_first_time_setup(&client, &app_data_dir, &password).await?,
    };

    *state.encryption_key.lock().await = Some(key);
    Ok(())
}