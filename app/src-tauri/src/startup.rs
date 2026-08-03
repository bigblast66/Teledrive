// startup.rs — the glue that ties Phase 2's key derivation into a real
// "don't ask every time" flow, backed by the OS keychain for local caching.
//
// Add `keyring = "3"` to Cargo.toml.

use crate::crypto;
use keyring::Entry;

const KEYCHAIN_SERVICE: &str = "telegram-drive";
const KEYCHAIN_USER: &str = "encryption-key";

/// Try to load a cached key from the OS keychain. Returns None if nothing
/// is cached yet, or the keychain is unavailable/cleared.
fn load_cached_key() -> Option<[u8; 32]> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).ok()?;
    let hex_key = entry.get_password().ok()?;
    let bytes = hex_decode(&hex_key)?;
    bytes.try_into().ok()
}

/// Cache the derived key in the OS keychain so future launches don't need
/// the password again.
fn cache_key(key: &[u8; 32]) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    entry.set_password(&hex_encode(key)).map_err(|e| e.to_string())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// The canary phrase used to verify a password is correct.
const CANARY_PLAINTEXT: &[u8] = b"TELEGRAM_DRIVE_KEY_OK";

/// Represents what we found stored on Telegram (in e.g. Saved Messages),
/// if anything. In the real app this comes from an actual message fetch —
/// stubbed here as the shape of the data, not the Telegram call itself.
pub struct RemoteVault {
    pub salt: [u8; 16],
    pub canary_ciphertext: Vec<u8>,
    pub canary_nonce_prefix: [u8; 4],
}

/// Marker prefix so we can find our vault message among all Saved Messages,
/// and so we don't accidentally parse an unrelated message as the vault.
const VAULT_MARKER: &str = "TGDRIVE_VAULT_V1:";

fn encode_vault(vault: &RemoteVault) -> String {
    let mut raw = Vec::new();
    raw.extend_from_slice(&vault.salt);
    raw.extend_from_slice(&vault.canary_nonce_prefix);
    raw.extend_from_slice(&vault.canary_ciphertext);
    format!("{VAULT_MARKER}{}", hex_encode(&raw))
}

fn decode_vault(text: &str) -> Option<RemoteVault> {
    let hex = text.strip_prefix(VAULT_MARKER)?;
    let raw = hex_decode(hex)?;
    if raw.len() < 20 {
        return None;
    }
    let salt: [u8; 16] = raw[0..16].try_into().ok()?;
    let canary_nonce_prefix: [u8; 4] = raw[16..20].try_into().ok()?;
    let canary_ciphertext = raw[20..].to_vec();
    Some(RemoteVault { salt, canary_ciphertext, canary_nonce_prefix })
}

/// Attempt to fetch the salt+canary from Telegram Saved Messages.
/// Returns None if this account has never set up encryption.
pub async fn fetch_remote_vault(client: &grammers_client::Client) -> Option<RemoteVault> {
    use grammers_tl_types as tl;
    let self_peer = tl::types::InputPeerSelf {};

    let mut iter = client.search_messages(self_peer).query(VAULT_MARKER);
    while let Ok(Some(message)) = iter.next().await {
        if let Some(vault) = decode_vault(message.text()) {
            return Some(vault);
        }
    }
    None
}

/// Store a freshly-generated salt+canary on Telegram Saved Messages.
/// Called only once, the very first time this account sets up encryption.
pub async fn store_remote_vault(client: &grammers_client::Client, vault: &RemoteVault) -> Result<(), String> {
    use grammers_tl_types as tl;
    let self_peer = tl::types::InputPeerSelf {};
    let text = encode_vault(vault);

    client
        .send_message(self_peer, text.as_str())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Given a password and a fetched RemoteVault, verify the password is
/// correct and return the derived key on success.
fn verify_password_against_vault(password: &str, vault: &RemoteVault) -> Result<[u8; 32], String> {
    let key = crypto::derive_key(password, &vault.salt);
    let decrypted = crypto::decrypt_block(&key, &vault.canary_nonce_prefix, 0, &vault.canary_ciphertext)?;
    if decrypted == CANARY_PLAINTEXT {
        Ok(key)
    } else {
        Err("wrong password".to_string())
    }
}

/// The full startup flow. Call this once, early in app initialization,
/// before any file-browser UI becomes reachable. `has_local_credentials`
/// checks your local db for API ID/hash (already-existing app logic).
///
/// Returns the unlocked key on success, to be stored in
/// `TelegramState.encryption_key`.
pub enum StartupOutcome {
    /// Key loaded silently — no prompt was needed.
    UnlockedSilently([u8; 32]),
    /// Caller must now show a password prompt and call
    /// `complete_unlock_with_password` with what the user enters.
    NeedsPasswordPrompt { vault: RemoteVault },
    /// Caller must show a "choose a new master password" prompt and call
    /// `complete_first_time_setup` with what the user enters.
    NeedsFirstTimeSetup,
}

pub async fn determine_startup_path(client: &grammers_client::Client, local_db_has_credentials: bool) -> Result<StartupOutcome, String> {
    if local_db_has_credentials {
        if let Some(key) = load_cached_key() {
            return Ok(StartupOutcome::UnlockedSilently(key));
        }
    }

    // No usable local cache — check Telegram as the source of truth.
    match fetch_remote_vault(client).await {
        Some(vault) => Ok(StartupOutcome::NeedsPasswordPrompt { vault }),
        None => Ok(StartupOutcome::NeedsFirstTimeSetup),
    }
}

/// Called after the user enters their existing password in response to
/// NeedsPasswordPrompt.
pub fn complete_unlock_with_password(password: &str, vault: &RemoteVault) -> Result<[u8; 32], String> {
    let key = verify_password_against_vault(password, vault)?;
    let _ = cache_key(&key); // best-effort; app still works if keychain fails
    Ok(key)
}

/// Called after the user chooses a NEW password in response to
/// NeedsFirstTimeSetup.
pub async fn complete_first_time_setup(client: &grammers_client::Client, password: &str) -> Result<[u8; 32], String> {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let mut nonce_prefix = [0u8; 4];
    rand::rng().fill_bytes(&mut nonce_prefix);

    let key = crypto::derive_key(password, &salt);
    let canary_ciphertext = crypto::encrypt_canary(&key, &nonce_prefix, CANARY_PLAINTEXT)?;

    let vault = RemoteVault { salt, canary_ciphertext, canary_nonce_prefix: nonce_prefix };
    store_remote_vault(client, &vault).await?;

    let _ = cache_key(&key);
    Ok(key)
}