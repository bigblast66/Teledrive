// crypto.rs
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit};
use argon2::Argon2;
use rand::RngCore;
use std::fs;

pub fn derive_key(password: &str, salt: &[u8; 16]) -> [u8; 32] {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .expect("argon2 key derivation failed");
    key
}

fn block_nonce(nonce_prefix: &[u8; 4], block_index: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(nonce_prefix);
    nonce[4..].copy_from_slice(&block_index.to_be_bytes());
    nonce
}

fn encrypt_block(key: &[u8; 32], nonce_prefix: &[u8; 4], block_index: u64, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = block_nonce(nonce_prefix, block_index);
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher.encrypt(nonce, plaintext).map_err(|_| "encryption failed".to_string())
}

pub fn decrypt_block(key: &[u8; 32], nonce_prefix: &[u8; 4], block_index: u64, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = block_nonce(nonce_prefix, block_index);
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|_| "wrong key or corrupted block".to_string())
}

pub const BLOCK_SIZE: usize = 524288; // 1MB — bump up from the demo's 64KB

// NOTE: these were previously `.expect()`-based (panicking on any failure —
// which aborts the whole process on Android release builds) AND loaded the
// *entire* file into a Vec<u8>, then built a second same-sized Vec<u8> for
// the output, all before writing anything to disk. For a multi-hundred-MB or
// multi-GB video/photo that's 2x the file size resident in RAM at once,
// which is exactly the kind of allocation that gets a foreground app killed/
// backgrounded by Android's low-memory killer — matching "upload always
// minimizes/crashes". These are now fully streaming: at most one BLOCK_SIZE
// chunk (~1MB) is ever held in memory, regardless of file size. They also
// return Result instead of panicking, so callers can surface a normal
// "upload/download failed" error. They still do blocking I/O, so callers
// MUST run them via tokio::task::spawn_blocking rather than calling them
// directly inside an async fn.
pub fn encrypt_file(input_path: &str, output_path: &str, key: &[u8; 32]) -> Result<(), String> {
    use std::io::{BufReader, BufWriter, Read, Write};

    let input_file = fs::File::open(input_path).map_err(|e| format!("failed to open input file: {e}"))?;
    let mut reader = BufReader::new(input_file);

    let output_file = fs::File::create(output_path).map_err(|e| format!("failed to create encrypted output: {e}"))?;
    let mut writer = BufWriter::new(output_file);

    let mut nonce_prefix = [0u8; 4];
    rand::rng().fill_bytes(&mut nonce_prefix);   // <- rand 0.9 fix from earlier
    writer.write_all(&nonce_prefix).map_err(|e| format!("failed to write encrypted output: {e}"))?;

    let mut buf = vec![0u8; BLOCK_SIZE];
    let mut block_index: u64 = 0;
    loop {
        let mut filled = 0;
        // read_exact-style loop: keep reading until the buffer is full or EOF,
        // since a single Read::read call isn't guaranteed to fill the buffer.
        while filled < buf.len() {
            let n = reader.read(&mut buf[filled..]).map_err(|e| format!("failed to read input file: {e}"))?;
            if n == 0 { break; }
            filled += n;
        }
        if filled == 0 { break; }

        let ciphertext_block = encrypt_block(key, &nonce_prefix, block_index, &buf[..filled])?;
        writer.write_all(&ciphertext_block).map_err(|e| format!("failed to write encrypted output: {e}"))?;
        block_index += 1;

        if filled < buf.len() { break; } // last (short) block, EOF reached
    }

    writer.flush().map_err(|e| format!("failed to write encrypted output: {e}"))
}


pub fn decrypt_file(input_path: &str, output_path: &str, key: &[u8; 32]) -> Result<(), String> {
    use std::io::{BufReader, BufWriter, Read, Write};

    let input_file = fs::File::open(input_path).map_err(|e| format!("failed to read encrypted file: {e}"))?;
    let mut reader = BufReader::new(input_file);

    let mut nonce_prefix = [0u8; 4];
    reader.read_exact(&mut nonce_prefix).map_err(|_| "file too short for header".to_string())?;

    let output_file = fs::File::create(output_path).map_err(|e| format!("failed to create decrypted output: {e}"))?;
    let mut writer = BufWriter::new(output_file);

    let encrypted_block_size = BLOCK_SIZE + 16; // GCM tag adds 16 bytes per block
    let mut buf = vec![0u8; encrypted_block_size];
    let mut block_index: u64 = 0;
    loop {
        let mut filled = 0;
        while filled < buf.len() {
            let n = reader.read(&mut buf[filled..]).map_err(|e| format!("failed to read encrypted file: {e}"))?;
            if n == 0 { break; }
            filled += n;
        }
        if filled == 0 { break; }

        let plaintext_block = decrypt_block(key, &nonce_prefix, block_index, &buf[..filled])
            .map_err(|e| format!("decryption failed - {e}"))?;
        writer.write_all(&plaintext_block).map_err(|e| format!("failed to write decrypted output: {e}"))?;
        block_index += 1;

        if filled < buf.len() { break; } // last (short) block, EOF reached
    }

    writer.flush().map_err(|e| format!("failed to write decrypted output: {e}"))
}

pub fn dev_key() -> [u8; 32] {
    derive_key("temporary-dev-password", &[42u8; 16])
}


pub fn plaintext_size(encrypted_size: u64, block_size: u64) -> u64 {
    let ciphertext_total = encrypted_size - 4;
    let encrypted_block_size = block_size + 16;
    let num_blocks = (ciphertext_total + encrypted_block_size - 1) / encrypted_block_size; // ceil div
    let tag_overhead = num_blocks * 16;
    ciphertext_total - tag_overhead
}


/// Encrypt a single small block — used for the canary value during setup/unlock.
pub fn encrypt_canary(key: &[u8; 32], nonce_prefix: &[u8; 4], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    encrypt_block(key, nonce_prefix, 0, plaintext)
}

pub fn generate_thumbnail(input_path: &str) -> Option<Vec<u8>> {
    let img = image::open(input_path).ok()?;
    let thumb = img.resize(200, 200, image::imageops::FilterType::Triangle);
    let mut buf = Vec::new();
    thumb.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg).ok()?;
    Some(buf)
}