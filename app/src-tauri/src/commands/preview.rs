use tauri::State;
use tauri::Manager;
use std::sync::Arc;
use grammers_client::types::Media;
use base64::{Engine as _, engine::general_purpose};
use rand::Rng;
use tokio::io::AsyncWriteExt;
use crate::TelegramState;
use crate::bandwidth::BandwidthManager;
use crate::commands::utils::resolve_peer;

/// Supported image file extensions for thumbnails.
/// Shared between Tauri commands and the REST API cache cleanup.
pub const THUMBNAIL_EXTS: &[&str] = &["jpg", "png", "gif", "webp"];

const PREVIEW_CACHE_MAX_FILES: usize = 30;
const PREVIEW_CACHE_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

async fn prune_preview_cache(cache_dir: std::path::PathBuf, preserve_path: Option<std::path::PathBuf>) {
    let _ = tokio::task::spawn_blocking(move || {
        let mut read_dir = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        // First pass: delete any orphaned .part files left behind by
        // interrupted downloads. These are always stale and never preserved.
        for entry in read_dir.by_ref().flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.ends_with(".part") {
                let _ = std::fs::remove_file(&path);
            }
        }

        // Second pass: gather remaining files for size-based pruning.
        // Re-read the directory to get a fresh iterator after the first pass
        // may have modified it.
        let read_dir = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> = Vec::new();
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if preserve_path.as_ref().is_some_and(|preserve| preserve == &path) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                files.push((path, modified, meta.len()));
            }
        }
        files.sort_by_key(|(_, modified, _)| *modified);
        let mut total_bytes: u64 = files.iter().map(|(_, _, len)| *len).sum();
        while files.len() > PREVIEW_CACHE_MAX_FILES || total_bytes > PREVIEW_CACHE_MAX_TOTAL_BYTES {
            if let Some((path, _, len)) = files.first().cloned() {
                let _ = std::fs::remove_file(&path);
                total_bytes = total_bytes.saturating_sub(len);
                files.remove(0);
            } else {
                break;
            }
        }
    }).await;
}

const THUMBNAIL_CACHE_MAX_FILES: usize = 500;
const THUMBNAIL_CACHE_MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024; // 50MB — thumbnails are tiny, generous cap

async fn prune_thumbnail_cache(cache_dir: std::path::PathBuf) {
    let _ = tokio::task::spawn_blocking(move || {
        // Clean up any orphaned .part/.enc files left by interrupted requests
        let mut read_dir = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in read_dir.by_ref().flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.contains(".part") || fname.contains(".enc") {
                let _ = std::fs::remove_file(&path);
            }
        }

        let read_dir = match std::fs::read_dir(&cache_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, u64)> = Vec::new();
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            if let Ok(meta) = entry.metadata() {
                let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                files.push((path, modified, meta.len()));
            }
        }
        files.sort_by_key(|(_, modified, _)| *modified);
        let mut total_bytes: u64 = files.iter().map(|(_, _, len)| *len).sum();
        while files.len() > THUMBNAIL_CACHE_MAX_FILES || total_bytes > THUMBNAIL_CACHE_MAX_TOTAL_BYTES {
            if let Some((path, _, len)) = files.first().cloned() {
                let _ = std::fs::remove_file(&path);
                total_bytes = total_bytes.saturating_sub(len);
                files.remove(0);
            } else {
                break;
            }
        }
    }).await;
}

/// Download media to a file using `iter_download` with manual chunk writing.
/// Returns the number of bytes written.
///
/// Unlike `grammers_client::Client::download_media`, this returns an explicit
/// error when the download produces zero bytes (e.g. stale file references or
/// Telegram CDN stream drops).
async fn download_to_file<D: grammers_client::types::Downloadable>(
    client: &grammers_client::Client,
    media: &D,
    part_path: &std::path::Path,
) -> Result<u64, String> {
    let mut file = tokio::fs::File::create(part_path)
        .await
        .map_err(|e| format!("Failed to create .part file: {}", e))?;

    let mut download_iter = client.iter_download(media);
    download_iter = download_iter.chunk_size(65536);
    let mut written: u64 = 0;

    loop {
        match download_iter.next().await {
            Ok(Some(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("Write error: {}", e))?;
                written += chunk.len() as u64;
            }
            Ok(None) => break,
            Err(e) => {
                let _ = tokio::fs::remove_file(part_path).await;
                return Err(format!("Download error: {}", e));
            }
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    if written == 0 {
        let _ = tokio::fs::remove_file(part_path).await;
        return Err("Download produced zero bytes (stale file reference or stream drop)".to_string());
    }

    Ok(written)
}

#[tauri::command]
pub async fn cmd_get_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, Arc<BandwidthManager>>,
) -> Result<String, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    if tokio::fs::metadata(&cache_dir).await.is_err() {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
    }
    log::info!("Using preview cache dir: {:?}", cache_dir);
    log::info!("Preview Request: msg_id={}", message_id);
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let messages = client.get_messages_by_id(&peer, &[message_id])
        .await.map_err(|e| e.to_string())?;
    let target_message = messages.into_iter().flatten().next();

    if let Some(msg) = target_message {
        if let Some(media) = msg.media() {
            let ext = match &media {
                Media::Document(d) => {
                    let mut e = std::path::Path::new(d.name())
                        .extension()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if e.is_empty() {
                        if let Some(mime) = d.mime_type() {
                            e = match mime {
                                "image/jpeg" => "jpg".to_string(),
                                "image/png" => "png".to_string(),
                                "application/pdf" => "pdf".to_string(),
                                "video/mp4" => "mp4".to_string(),
                                _ => "bin".to_string(),
                            };
                        } else {
                            e = "bin".to_string();
                        }
                    }
                    e
                },
                Media::Photo(_) => "jpg".to_string(),
                _ => "bin".to_string(),
            };
            let folder_key = folder_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "home".to_string());
            let save_path = cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext));
            let save_path_str = save_path.to_string_lossy().to_string();
            
            // Prune the cache here, explicitly preserving the active file being previewed
            prune_preview_cache(cache_dir.clone(), Some(save_path.clone())).await;

            let cached_meta = tokio::fs::metadata(&save_path).await.ok();
            let file_ready = if cached_meta.as_ref().is_some_and(|meta| meta.len() > 0) {
                log::info!("File ({}) exists in cache.", message_id);
                true
            } else {
                if cached_meta.is_some() {
                    log::warn!("Preview cache file was empty; redownloading: {}", save_path_str);
                    let _ = tokio::fs::remove_file(&save_path).await;
                }
                let size = match &media {
                    Media::Document(d) => d.size() as u64,
                    Media::Photo(_) => 1024 * 1024,
                    _ => 0,
                };
                log::info!("Downloading preview... Size: {}", size);
                if let Err(e) = bw_state.try_reserve_down(size) {
                    log::warn!("Bandwidth limit hit for preview: {}", e);
                    false
                } else {
                    // Download to a temporary .enc file to avoid race conditions.
                    // Decrypt to .part file and atomically rename to save_path.
                    let unique_id = rand::rng().random::<u64>();
                    let enc_path = save_path.with_extension(format!("{}_{}.enc", ext, unique_id));
                    let part_path = save_path.with_extension(format!("{}_{}.part", ext, unique_id));

                    let mut download_ok = false;

                    // Early-exit: another concurrent request may have already completed
                    // the download and renamed its decrypted file to the final path.
                    if tokio::fs::metadata(&save_path).await.map_or(false, |m| m.len() > 0) {
                        log::info!("Preview already downloaded by concurrent request (final file exists)");
                        bw_state.release_down(size);
                        download_ok = true;
                    }

                    // Attempt 1: download with original media (may have stale file reference)
                    if !download_ok {
                        let _ = tokio::fs::remove_file(&enc_path).await;
                        match download_to_file(&client, &media, &enc_path).await {
                            Ok(written) => {
                                log::info!("Preview download complete: {} bytes.", written);
                                download_ok = true;
                            },
                            Err(e) => {
                                log::error!("Preview Download Error (attempt 1/2): {}", e);
                            }
                        }
                    } // end attempt 1

                    // Attempt 2: re-fetch the message to get fresh file references, then retry
                    if !download_ok {
                        // Brief backoff before re-fetching
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                        if let Ok(fresh_messages) = client.get_messages_by_id(&peer, &[message_id]).await {
                            if let Some(fresh_msg) = fresh_messages.into_iter().flatten().next() {
                                if let Some(fresh_media) = fresh_msg.media() {
                                    let _ = tokio::fs::remove_file(&enc_path).await;
                                    match download_to_file(&client, &fresh_media, &enc_path).await {
                                        Ok(written) => {
                                            log::info!("Preview download complete after re-fetch: {} bytes.", written);
                                            download_ok = true;
                                        },
                                        Err(e) => {
                                            log::error!("Preview Download Error (attempt 2/2): {}", e);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if !download_ok {
                        let _ = tokio::fs::remove_file(&enc_path).await;
                        bw_state.release_down(size);
                        false
                    } else {
                        // Decrypt from enc_path to part_path
                        let src = enc_path.to_str().ok_or("invalid encrypted path")?.to_string();
                        let dst = part_path.to_str().ok_or("invalid part path")?.to_string();
                        let dec_res = tokio::task::spawn_blocking(move || {
                            crate::crypto::decrypt_file(&src, &dst, &crate::crypto::dev_key())
                        })
                        .await
                        .map_err(|e| format!("decryption task panicked: {e}"))?;

                        let _ = tokio::fs::remove_file(&enc_path).await;

                        if let Err(e) = dec_res {
                            let _ = tokio::fs::remove_file(&part_path).await;
                            bw_state.release_down(size);
                            log::error!("Preview decryption error: {}", e);
                            return Err(format!("Preview decryption failed: {e}"));
                        }

                        // Atomically rename decrypted part file to final save_path
                        match tokio::fs::rename(&part_path, &save_path).await {
                            Ok(_) => {
                                prune_preview_cache(cache_dir.clone(), Some(save_path.clone())).await;
                                true
                            },
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                                if tokio::fs::metadata(&save_path).await.map_or(false, |m| m.len() > 0) {
                                    log::info!("Preview already decrypted by concurrent request");
                                    true
                                } else {
                                    false
                                }
                            },
                            Err(e) => {
                                log::error!("Failed to rename part file to final path: {}", e);
                                let _ = tokio::fs::remove_file(&part_path).await;
                                false
                            }
                        }
                    }
                }
            };
            if file_ready {
                let lower_ext = ext.to_lowercase();
                if ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].contains(&lower_ext.as_str()) {
                    log::info!("Converting file to Base64...");
                    match tokio::fs::read(&save_path).await {
                        Ok(bytes) => {
                            let b64 = general_purpose::STANDARD.encode(&bytes);
                            let mime = match lower_ext.as_str() {
                                "png" => "image/png",
                                "gif" => "image/gif",
                                "webp" => "image/webp",
                                "bmp" => "image/bmp",
                                "svg" => "image/svg+xml",
                                _ => "image/jpeg",
                            };
                            return Ok(format!("data:{};base64,{}", mime, b64));
                        },
                        Err(e) => {
                            log::error!("Failed to read file for base64: {}", e);
                            return Ok(save_path_str);
                        }
                    }
                }
                log::info!("Returning path preview: {}", save_path_str);
                return Ok(save_path_str);
            }
        }
    }
    Err("File not found or failed to download".to_string())
}

#[tauri::command]
pub async fn cmd_clean_preview_cache(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");

    let _ = tokio::task::spawn_blocking(move || {
        if cache_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(cache_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }).await;
    Ok(())
}

#[tauri::command]
pub async fn cmd_clean_cache(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");
    let thumb_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");

    let _ = tokio::task::spawn_blocking(move || {
        if cache_dir.exists() {
            let _ = std::fs::remove_dir_all(cache_dir);
        }
        if thumb_dir.exists() {
            let _ = std::fs::remove_dir_all(thumb_dir);
        }
    }).await;
    Ok(())
}

/// Get a small thumbnail for inline display in file cards.
/// Returns base64 data URL for images, empty string for non-image files.
/// Uses same cache as cmd_get_preview for consistency.
#[tauri::command]
pub async fn cmd_get_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    // Check if thumbnail already in cache
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");
    if tokio::fs::metadata(&cache_dir).await.is_err() {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
    }

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());

    // Check for any cached thumbnail for this message by checking predicted paths
    let supported_exts = THUMBNAIL_EXTS;
    for ext in supported_exts {
        let path = cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext));
        if tokio::fs::metadata(&path).await.is_ok() {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                let mime = match *ext {
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    _ => "image/jpeg",
                };
                let b64 = general_purpose::STANDARD.encode(&bytes);
                return Ok(format!("data:{};base64,{}", mime, b64));
            }
        }
    }

    // No cache, need to fetch from Telegram
    let client_opt = { state.client.lock().await.clone() };
    #[cfg(debug_assertions)]
    if client_opt.is_none() {
        return Ok("".to_string());
    }
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    // Fetch the companion thumbnail message (always sent immediately after the real file)
    let thumb_msg_id = message_id + 1;
    let thumb_messages = client.get_messages_by_id(&peer, &[thumb_msg_id])
        .await.map_err(|e| e.to_string())?;

    let media = match thumb_messages.into_iter().flatten().next().and_then(|m| m.media()) {
        Some(m) => m,
        None => return Ok("".to_string()),
    };

    let save_path = cache_dir.join(format!("{}_{}.jpg", folder_key, message_id));

    // Early-exit: another concurrent request may have already cached this
    if tokio::fs::metadata(&save_path).await.map_or(false, |m| m.len() > 0) {
        if let Ok(bytes) = tokio::fs::read(&save_path).await {
            let b64 = general_purpose::STANDARD.encode(&bytes);
            return Ok(format!("data:image/jpeg;base64,{}", b64));
        }
    }

    let unique_id = rand::rng().random::<u64>();
    let part_path = save_path.with_extension(format!("jpg_{}.part", unique_id));
    let enc_path = save_path.with_extension(format!("jpg_{}.enc", unique_id));

    // Attempt 1: download with the reference we already have
    let mut download_ok = download_to_file(&client, &media, &enc_path).await.is_ok();

    // Attempt 2: file reference may have expired — re-fetch the message for a fresh one
    if !download_ok {
        let _ = tokio::fs::remove_file(&enc_path).await;
        if let Ok(fresh_messages) = client.get_messages_by_id(&peer, &[thumb_msg_id]).await {
            if let Some(fresh_media) = fresh_messages.into_iter().flatten().next().and_then(|m| m.media()) {
                download_ok = download_to_file(&client, &fresh_media, &enc_path).await.is_ok();
            }
        }
    }

    if !download_ok {
        let _ = tokio::fs::remove_file(&enc_path).await;
        return Ok("".to_string());
    }

    {
        let src = enc_path.to_str().ok_or("invalid encrypted path")?.to_string();
        let dst = part_path.to_str().ok_or("invalid part path")?.to_string();
        let result = tokio::task::spawn_blocking(move || {
            crate::crypto::decrypt_file(&src, &dst, &crate::crypto::dev_key())
        })
        .await
        .map_err(|e| format!("decryption task panicked: {e}"))?;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&enc_path).await;
            return Err(e);
        }
    }
    let _ = tokio::fs::remove_file(&enc_path).await;

    // Atomically rename part file to final path (Ok = we won the race,
    // NotFound = a concurrent request already renamed theirs — either way, read save_path)
    match tokio::fs::rename(&part_path, &save_path).await {
        Ok(_) | Err(_) => {
            if let Ok(bytes) = tokio::fs::read(&save_path).await {
                let b64 = general_purpose::STANDARD.encode(&bytes);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Ok(format!("data:image/jpeg;base64,{}", b64));
            }
            let _ = tokio::fs::remove_file(&part_path).await;
        }
    }

    match tokio::fs::rename(&part_path, &save_path).await {
        Ok(_) | Err(_) => {
            if let Ok(bytes) = tokio::fs::read(&save_path).await {
                let b64 = general_purpose::STANDARD.encode(&bytes);
                let _ = tokio::fs::remove_file(&part_path).await;
                prune_thumbnail_cache(cache_dir.clone()).await; // NEW
                return Ok(format!("data:image/jpeg;base64,{}", b64));
            }
            let _ = tokio::fs::remove_file(&part_path).await;
        }
    }

    Ok("".to_string())
}

/// Delete stale preview cache entries for a specific message in a specific folder.
/// Preview cache files are named `{folder_key}_{message_id}.{ext}`.
/// This removes all extensions for the given folder+message_id pair.
#[tauri::command]
pub async fn cmd_delete_preview_for_message(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("previews");

    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());

    let prefix = format!("{}_{}.", folder_key, message_id);

    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if fname.starts_with(&prefix) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }).await;
    Ok(())
}

#[tauri::command]
pub async fn cmd_delete_image_thumbnail(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| e.to_string())?
        .join("thumbnails");
        
    let folder_key = folder_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "home".to_string());

    let _ = tokio::task::spawn_blocking(move || {
        let supported_exts = THUMBNAIL_EXTS;
        for ext in supported_exts {
            let path = cache_dir.join(format!("{}_{}.{}", folder_key, message_id, ext));
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
        }
    }).await;
    Ok(())
}


const TEXT_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024; // 2MB cap — no reason to load more into a preview pane

#[tauri::command]
pub async fn cmd_get_text_preview(
    message_id: i32,
    folder_id: Option<i64>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<String, String> {
    let cache_dir = app_handle.path().app_data_dir().map_err(|e: tauri::Error| e.to_string())?.join("previews");
    if tokio::fs::metadata(&cache_dir).await.is_err() {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
    }

    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or_else(|| "Client not connected".to_string())?;
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let messages = client.get_messages_by_id(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    let msg = messages.into_iter().flatten().next().ok_or("File not found")?;
    let media = msg.media().ok_or("No media on this message")?;

    let size = match &media {
        Media::Document(d) => d.size() as u64,
        _ => 0,
    };
    if size > TEXT_PREVIEW_MAX_BYTES {
        return Err(format!("File too large to preview ({} bytes) — open externally instead", size));
    }

    let unique_id = rand::rng().random::<u64>();
    let enc_path = cache_dir.join(format!("text_{}_{}.enc", message_id, unique_id));
    let dec_path = cache_dir.join(format!("text_{}_{}.dec", message_id, unique_id));

    download_to_file(&client, &media, &enc_path).await.map_err(|e| e.to_string())?;
    {
        let src = enc_path.to_str().ok_or("invalid encrypted path")?.to_string();
        let dst = dec_path.to_str().ok_or("invalid decrypted path")?.to_string();
        let result = tokio::task::spawn_blocking(move || {
            crate::crypto::decrypt_file(&src, &dst, &crate::crypto::dev_key())
        })
        .await
        .map_err(|e| format!("decryption task panicked: {e}"))?;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&enc_path).await;
            return Err(e);
        }
    }
    let _ = tokio::fs::remove_file(&enc_path).await;

    let content = tokio::fs::read_to_string(&dec_path).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&dec_path).await; // temp file, no reason to keep it cached

    Ok(content)
}