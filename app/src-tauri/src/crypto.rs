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

fn encrypt_block(key: &[u8; 32], nonce_prefix: &[u8; 4], block_index: u64, plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = block_nonce(nonce_prefix, block_index);
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher.encrypt(nonce, plaintext).expect("encryption failed")
}

pub fn decrypt_block(key: &[u8; 32], nonce_prefix: &[u8; 4], block_index: u64, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = block_nonce(nonce_prefix, block_index);
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|_| "wrong key or corrupted block".to_string())
}

pub const BLOCK_SIZE: usize = 524288; // 1MB — bump up from the demo's 64KB

pub fn encrypt_file(input_path: &str, output_path: &str, key: &[u8; 32]) {
    let plaintext = fs::read(input_path).expect("failed to read input file");

    let mut nonce_prefix = [0u8; 4];
    rand::rng().fill_bytes(&mut nonce_prefix);   // <- rand 0.9 fix from earlier

    let mut output = Vec::new();
    output.extend_from_slice(&nonce_prefix);

    let mut block_index: u64 = 0;
    for chunk in plaintext.chunks(BLOCK_SIZE) {
        let ciphertext_block = encrypt_block(key, &nonce_prefix, block_index, chunk);
        output.extend_from_slice(&ciphertext_block);
        block_index += 1;
    }

    fs::write(output_path, &output).expect("failed to write encrypted output");
}


pub fn decrypt_file(input_path: &str, output_path: &str, key: &[u8; 32]) {
    let data = fs::read(input_path).expect("failed to read encrypted file");

    let nonce_prefix: [u8; 4] = data[0..4].try_into().expect("file too short for header");
    let ciphertext = &data[4..];

    let encrypted_block_size = BLOCK_SIZE + 16; // GCM tag adds 16 bytes per block
    let mut output = Vec::new();
    let mut block_index: u64 = 0;

    for chunk in ciphertext.chunks(encrypted_block_size) {
        let plaintext_block = decrypt_block(key, &nonce_prefix, block_index, chunk)
            .expect("decryption failed - wrong key or corrupted data");
        output.extend_from_slice(&plaintext_block);
        block_index += 1;
    }

    fs::write(output_path, &output).expect("failed to write decrypted output");
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
pub fn encrypt_canary(key: &[u8; 32], nonce_prefix: &[u8; 4], plaintext: &[u8]) -> Vec<u8> {
    encrypt_block(key, nonce_prefix, 0, plaintext)
}