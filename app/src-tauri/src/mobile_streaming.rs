use std::sync::Arc;
use std::sync::OnceLock;
use std::collections::HashMap;
use tokio::sync::RwLock;
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use grammers_client::types::Media;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::crypto::{self, BLOCK_SIZE};

const ENC_BLOCK: u64 = (BLOCK_SIZE + 16) as u64;
const CDN_ALIGNMENT: u64 = 524288;

/// In-memory cache for the 4-byte nonce prefix of encrypted files.
/// This prevents every HTTP Range request (probing, seeking, scrubbing)
/// from making an extra 64 KB Telegram MTProto roundtrip.
fn get_nonce_cache() -> &'static RwLock<HashMap<i32, [u8; 4]>> {
    static CACHE: OnceLock<RwLock<HashMap<i32, [u8; 4]>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Parses an HTTP Range header value like "bytes=0-1048575", "bytes=5000-", or suffix "bytes=-500000"
fn parse_range(header_val: &str, total_size: u64) -> Option<(u64, u64)> {
    if total_size == 0 || !header_val.starts_with("bytes=") {
        return None;
    }
    let s = header_val["bytes=".len()..].trim();
    if s.is_empty() {
        return None;
    }

    // Handle suffix range: bytes=-500000 (last 500,000 bytes)
    if s.starts_with('-') {
        let suffix_len = s[1..].trim().parse::<u64>().ok()?;
        let start = total_size.saturating_sub(suffix_len);
        let end = total_size.saturating_sub(1);
        return if start <= end { Some((start, end)) } else { None };
    }

    let parts: Vec<&str> = s.split('-').collect();
    if parts.is_empty() {
        return None;
    }
    let start = parts[0].trim().parse::<u64>().ok()?;
    let end = if parts.len() > 1 && !parts[1].trim().is_empty() {
        let parsed_end = parts[1].trim().parse::<u64>().ok()?;
        std::cmp::min(parsed_end, total_size.saturating_sub(1))
    } else {
        total_size.saturating_sub(1)
    };
    if start <= end {
        Some((start, end))
    } else {
        None
    }
}

/// Start the lightweight Tokio-native streaming server on loopback.
/// This runs purely on Tauri's existing Tokio event loop with zero thread conflicts.
pub async fn start_mobile_streaming_server(
    state: Arc<TelegramState>,
    port: u16,
    token: String,
) -> std::io::Result<()> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            log::info!("Mobile Streaming Server listening on {} (IPv4)", addr);
            l
        }
        Err(e) => {
            log::warn!("Mobile Streaming Server IPv4 bind failed ({}), falling back to [::1]", e);
            let ipv6_addr = format!("[::1]:{}", port);
            TcpListener::bind(&ipv6_addr).await?
        }
    };

    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("Mobile streaming listener accept error: {}", e);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };

        let state_clone = state.clone();
        let token_clone = token.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_stream_client(&mut socket, state_clone, &token_clone).await {
                log::debug!("Mobile stream client closed or completed: {}", e);
            }
        });
    }
}

async fn handle_stream_client(
    socket: &mut tokio::net::TcpStream,
    state: Arc<TelegramState>,
    expected_token: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = [0u8; 4096];
    let n = socket.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let req_str = String::from_utf8_lossy(&buf[..n]);

    let first_line = req_str.lines().next().unwrap_or_default();
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n").await;
        return Ok(());
    }

    let method = parts[0];
    let uri = parts[1];

    // Handle CORS preflight
    if method == "OPTIONS" {
        let resp = "HTTP/1.1 200 OK\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
                    Access-Control-Allow-Headers: Range, Authorization\r\n\
                    Content-Length: 0\r\n\
                    Connection: close\r\n\r\n";
        let _ = socket.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    // Expect URI format: /stream/{folder_id}/{message_id}?token={token}
    let (path_part, query_part) = uri.split_once('?').unwrap_or((uri, ""));

    // Validate token
    let query_token = query_part.split('&').find_map(|pair| {
        let mut kv = pair.split('=');
        if kv.next()? == "token" {
            kv.next()
        } else {
            None
        }
    });

    if query_token != Some(expected_token) {
        log::warn!("Mobile stream request rejected: invalid or missing token");
        let _ = socket.write_all(b"HTTP/1.1 403 Forbidden\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nInvalid stream token").await;
        return Ok(());
    }

    let path_segments: Vec<&str> = path_part.trim_matches('/').split('/').collect();
    if path_segments.len() < 3 || path_segments[0] != "stream" {
        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nNot Found").await;
        return Ok(());
    }

    let folder_id_str = path_segments[1];
    let message_id: i32 = match path_segments[2].parse() {
        Ok(id) => id,
        Err(_) => {
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nInvalid message id").await;
            return Ok(());
        }
    };

    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        None
    } else {
        folder_id_str.parse::<i64>().ok()
    };

    // Extract Range header
    let mut req_range: Option<String> = None;
    for line in req_str.lines() {
        let trimmed = line.trim();
        if trimmed.to_ascii_lowercase().starts_with("range:") {
            if let Some(r) = trimmed.split(':').nth(1) {
                req_range = Some(r.trim().to_string());
            }
        }
    }

    // Acquire Telegram client
    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => {
            let _ = socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nClient not connected").await;
            return Ok(());
        }
    };

    let peer = match resolve_peer(&client, folder_id, &state.peer_cache).await {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.write_all(format!("HTTP/1.1 400 Bad Request\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}", e).as_bytes()).await;
            return Ok(());
        }
    };

    let messages = match client.get_messages_by_id(&peer, &[message_id]).await {
        Ok(m) => m,
        Err(e) => {
            let _ = socket.write_all(format!("HTTP/1.1 500 Internal Error\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{}", e).as_bytes()).await;
            return Ok(());
        }
    };

    let msg = match messages.into_iter().flatten().next() {
        Some(m) => m,
        None => {
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nMessage not found").await;
            return Ok(());
        }
    };

    let media = match msg.media() {
        Some(m) => m,
        None => {
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nNo media in message").await;
            return Ok(());
        }
    };

    // Read 4-byte nonce header from cache or file start
    let nonce_prefix: [u8; 4] = {
        let cached = {
            let read_guard = get_nonce_cache().read().await;
            read_guard.get(&message_id).copied()
        };
        if let Some(prefix) = cached {
            prefix
        } else {
            let mut header_iter = client.iter_download(&media).chunk_size(65536);
            let prefix = match header_iter.next().await {
                Ok(Some(chunk)) if chunk.len() >= 4 => chunk[0..4].try_into().unwrap(),
                _ => {
                    let _ = socket.write_all(b"HTTP/1.1 500 Internal Error\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nFailed to read file header").await;
                    return Ok(());
                }
            };
            let mut write_guard = get_nonce_cache().write().await;
            if write_guard.len() > 500 {
                write_guard.clear();
            }
            write_guard.insert(message_id, prefix);
            prefix
        }
    };

    let raw_size = match &media {
        Media::Document(d) => d.size() as u64,
        Media::Photo(_) => 0,
        _ => 0,
    };
    let size = if raw_size > 0 { crypto::plaintext_size(raw_size, BLOCK_SIZE as u64) } else { 0 };

    let (start_byte, end_byte, is_range) = if let Some(ref r) = req_range {
        if let Some((s, e)) = parse_range(r, size) {
            (s, e, true)
        } else {
            (0, if size > 0 { size - 1 } else { 0 }, false)
        }
    } else {
        (0, if size > 0 { size - 1 } else { 0 }, false)
    };

    let content_length = if size > 0 { end_byte.saturating_sub(start_byte) + 1 } else { 0 };

    // Accurately determine MIME type from filename extension for Android WebView / Chromium
    let raw_filename = match &media {
        Media::Document(d) => {
            let caption = msg.text();
            if !caption.is_empty() {
                caption.to_string()
            } else {
                d.name().to_string()
            }
        }
        _ => String::new(),
    };
    let ext = std::path::Path::new(&raw_filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "aac" => "audio/aac",
        _ => match &media {
            Media::Document(d) => match d.mime_type() {
                Some("application/octet-stream") | None => "video/mp4",
                Some(m) => m,
            },
            _ => "video/mp4",
        },
    };

    // Extract duration from Telegram document attributes if available
    let mut duration_secs: Option<f64> = None;
    if let Media::Document(d) = &media {
        if let Some(grammers_tl_types::enums::Document::Document(doc)) = &d.raw.document {
            for attr in &doc.attributes {
                match attr {
                    grammers_tl_types::enums::DocumentAttribute::Video(v) => {
                        duration_secs = Some(v.duration);
                    }
                    grammers_tl_types::enums::DocumentAttribute::Audio(a) => {
                        duration_secs = Some(a.duration as f64);
                    }
                    _ => {}
                }
            }
        }
    }

    let duration_header = if let Some(dur) = duration_secs {
        format!("Content-Duration: {}\r\nX-Content-Duration: {}\r\n", dur, dur)
    } else {
        String::new()
    };

    // Send HTTP response headers
    let resp_headers = if is_range {
        format!(
            "HTTP/1.1 206 Partial Content\r\n\
            Content-Type: {}\r\n\
            Content-Length: {}\r\n\
            Content-Range: bytes {}-{}/{}\r\n\
            Accept-Ranges: bytes\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
            Access-Control-Allow-Headers: Range, Authorization\r\n\
            {}Cache-Control: private, max-age=120\r\n\
            Connection: close\r\n\r\n",
            mime, content_length, start_byte, end_byte, size, duration_header
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\n\
            Content-Type: {}\r\n\
            Content-Length: {}\r\n\
            Accept-Ranges: bytes\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
            Access-Control-Allow-Headers: Range, Authorization\r\n\
            {}Cache-Control: private, max-age=120\r\n\
            Connection: close\r\n\r\n",
            mime, size, duration_header
        )
    };
    socket.write_all(resp_headers.as_bytes()).await?;

    if method == "HEAD" {
        return Ok(());
    }

    // Map requested plaintext byte range to Telegram encrypted block range
    let start_block = start_byte / BLOCK_SIZE as u64;
    let end_block = end_byte / BLOCK_SIZE as u64;
    let offset_in_first_block = (start_byte % BLOCK_SIZE as u64) as usize;
    let enc_start_offset = 4 + start_block * ENC_BLOCK;

    let mut download_iter = client.iter_download(&media).chunk_size(CDN_ALIGNMENT as i32);
    let mut bytes_to_skip: usize = 0;

    if enc_start_offset > 0 {
        let cdn_aligned_start = (enc_start_offset / CDN_ALIGNMENT) * CDN_ALIGNMENT;
        let chunk_index = (cdn_aligned_start / CDN_ALIGNMENT) as i32;
        if chunk_index > 0 {
            download_iter = download_iter.skip_chunks(chunk_index);
        }
        bytes_to_skip = (enc_start_offset - cdn_aligned_start) as usize;
    }

    let dev_key = crate::crypto::dev_key();
    let mut skipped: usize = 0;
    let mut block_buffer: Vec<u8> = Vec::new();
    let mut current_block = start_block;
    let mut plaintext_yielded: u64 = 0;

    let mut expected_block_len = {
        let remaining_enc = raw_size - 4 - current_block * ENC_BLOCK;
        std::cmp::min(ENC_BLOCK, remaining_enc) as usize
    };

    while let Some(chunk) = download_iter.next().await.transpose() {
        match chunk {
            Ok(data) => {
                let mut data_slice = data;
                if skipped < bytes_to_skip {
                    let to_skip = bytes_to_skip - skipped;
                    if data_slice.len() <= to_skip {
                        skipped += data_slice.len();
                        continue;
                    } else {
                        data_slice = data_slice[to_skip..].to_vec();
                        skipped = bytes_to_skip;
                    }
                }

                block_buffer.extend_from_slice(&data_slice);

                while block_buffer.len() >= expected_block_len {
                    let block_cipher: Vec<u8> = block_buffer.drain(..expected_block_len).collect();
                    let plaintext_block = match crypto::decrypt_block(&dev_key, &nonce_prefix, current_block, &block_cipher) {
                        Ok(p) => p,
                        Err(e) => {
                            log::error!("Mobile stream decrypt error on block {}: {}", current_block, e);
                            return Ok(());
                        }
                    };

                    let mut slice: &[u8] = &plaintext_block;
                    if current_block == start_block {
                        slice = &slice[offset_in_first_block..];
                    }

                    let remaining_needed = content_length - plaintext_yielded;
                    let to_yield = std::cmp::min(remaining_needed, slice.len() as u64) as usize;

                    if let Err(e) = socket.write_all(&slice[..to_yield]).await {
                        // Client closed connection (e.g. paused, seeked, or left)
                        log::debug!("Mobile stream socket closed by client: {}", e);
                        return Ok(());
                    }

                    plaintext_yielded += to_yield as u64;
                    if plaintext_yielded >= content_length || current_block >= end_block {
                        let _ = socket.flush().await;
                        return Ok(());
                    }

                    current_block += 1;
                    let remaining_enc = raw_size - 4 - current_block * ENC_BLOCK;
                    expected_block_len = std::cmp::min(ENC_BLOCK, remaining_enc) as usize;
                }
            }
            Err(e) => {
                log::error!("Mobile stream Telegram download error: {}", e);
                return Ok(());
            }
        }
    }

    let _ = socket.flush().await;
    Ok(())
}
