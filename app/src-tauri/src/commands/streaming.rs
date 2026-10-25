use tauri::State;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use grammers_client::types::Media;

/// Holds the per-session streaming config (token + port)
pub struct StreamConfig {
    pub token: String,
    pub port: u16,
}

/// Returned to the frontend so it can construct stream URLs dynamically
#[derive(serde::Serialize)]
pub struct StreamInfo {
    pub token: String,
    pub base_url: String,
}

#[derive(serde::Serialize)]
pub struct MediaInfo {
    pub duration_secs: Option<f64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

/// Returns the streaming server's session token and base URL to the frontend.
/// The frontend must use the returned base_url to construct stream URLs,
/// never hardcoding the port.
#[tauri::command]
pub fn cmd_get_stream_info(config: State<'_, StreamConfig>) -> StreamInfo {
    // Always use "localhost" on all platforms.
    // "localhost" is treated as a secure context by all major browser
    // engines (Chromium/WebView2, WebKit) and is exempt from Mixed Content
    // blocking.  This is critical on Windows where Tauri v2 serves the
    // frontend from https://tauri.localhost — fetching http://127.0.0.1
    // from an HTTPS origin triggers a Mixed Content block in WebView2.
    // The server binds exclusively to 127.0.0.1, so name resolution
    // differences between platforms are not a concern.
    let host = "localhost";

    StreamInfo {
        token: config.token.clone(),
        base_url: format!("http://{}:{}", host, config.port),
    }
}

/// Returns media duration, width, height directly from Telegram document attributes.
#[tauri::command]
pub async fn cmd_get_media_info(
    message_id: i32,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<MediaInfo, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let messages = client.get_messages_by_id(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    let msg = messages.into_iter().flatten().next().ok_or_else(|| "Message not found".to_string())?;
    let media = msg.media().ok_or_else(|| "No media in message".to_string())?;

    let mut info = MediaInfo {
        duration_secs: None,
        width: None,
        height: None,
    };

    if let Media::Document(d) = media {
        if let Some(grammers_tl_types::enums::Document::Document(doc)) = &d.raw.document {
            for attr in &doc.attributes {
                match attr {
                    grammers_tl_types::enums::DocumentAttribute::Video(v) => {
                        info.duration_secs = Some(v.duration);
                        info.width = Some(v.w);
                        info.height = Some(v.h);
                    }
                    grammers_tl_types::enums::DocumentAttribute::Audio(a) => {
                        info.duration_secs = Some(a.duration as f64);
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(info)
}
