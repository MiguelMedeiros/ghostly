use pkarr::Keypair;
use std::env;
use tauri::State;

use crate::bitcoind_rpc::{self, RpcError};
use crate::crypto;
use crate::diagnostics;
use crate::lnd::{self, LndRequest, LndResponse};
use crate::local_fetch::{self, LocalResponse};
use crate::pkarr_client;
use crate::pkarr_network::Pkarr;
use crate::records::{self, RecordInput, ResolvedPacket};
use crate::types::{CompactMessage, KeypairResult, ResolvedBatch};
use crate::viewer::{self, ServiceResponse};

pub struct AppState {
    pub pkarr: Pkarr,
}

#[tauri::command]
pub fn get_profile() -> String {
    env::var("GHOSTLY_PROFILE").unwrap_or_default()
}

#[tauri::command]
pub fn create_keypair() -> Result<KeypairResult, String> {
    let keypair = Keypair::random();
    let secret = keypair.secret_key();
    let seed_b64 = crypto::to_base64_url(secret.as_ref());
    let pub_key_z32 = keypair.to_z32();

    Ok(KeypairResult {
        seed_b64,
        pub_key_z32,
    })
}

#[tauri::command]
pub fn get_public_key(seed_b64: String) -> Result<String, String> {
    let seed_bytes = crypto::from_base64_url(&seed_b64)?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| "Seed must be exactly 32 bytes")?;
    let keypair = Keypair::from_secret_key(&seed);
    Ok(keypair.to_z32())
}

#[tauri::command]
pub fn generate_enc_key() -> String {
    let key = crypto::generate_key();
    crypto::to_base64_url(&key)
}

#[tauri::command]
pub fn encrypt_text(plaintext: String, key_b64: String) -> Result<String, String> {
    let key_bytes = crypto::from_base64_url(&key_b64)?;
    crypto::encrypt(&plaintext, &key_bytes)
}

#[tauri::command]
pub fn decrypt_text(encoded: String, key_b64: String) -> Result<String, String> {
    let key_bytes = crypto::from_base64_url(&key_b64)?;
    crypto::decrypt(&encoded, &key_bytes)
}

#[tauri::command]
pub async fn publish_messages(
    state: State<'_, AppState>,
    seed_b64: String,
    messages: Vec<CompactMessage>,
    enc_key_b64: String,
    ack_timestamp: i64,
    nick: Option<String>,
    call_signal: Option<String>,
) -> Result<usize, String> {
    let seed_bytes = crypto::from_base64_url(&seed_b64)?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| "Seed must be exactly 32 bytes")?;
    let keypair = Keypair::from_secret_key(&seed);

    let enc_key = crypto::from_base64_url(&enc_key_b64)?;

    pkarr_client::publish_messages(
        &state.pkarr,
        &keypair,
        &messages,
        &enc_key,
        ack_timestamp,
        nick.as_deref(),
        call_signal.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn resolve_messages(
    state: State<'_, AppState>,
    public_key_z32: String,
    enc_key_b64: String,
) -> Result<Option<ResolvedBatch>, String> {
    let enc_key = crypto::from_base64_url(&enc_key_b64)?;

    pkarr_client::resolve_messages(&state.pkarr, &public_key_z32, &enc_key).await
}

// -- the shared TypeScript peer -------------------------------------------------

#[tauri::command]
pub async fn publish_records(
    state: State<'_, AppState>,
    seed_b64: String,
    records: Vec<RecordInput>,
) -> Result<(), String> {
    let seed_bytes = crypto::from_base64_url(&seed_b64)?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| "Seed must be exactly 32 bytes")?;
    let keypair = Keypair::from_secret_key(&seed);
    records::publish(&state.pkarr, &keypair, &records).await
}

/// A relay payload signed in the WebView (the profile's did:dht), published as is.
#[tauri::command]
pub async fn publish_signed_packet(
    state: State<'_, AppState>,
    public_key_z32: String,
    payload_b64: String,
) -> Result<(), String> {
    let payload = crypto::from_base64_url(&payload_b64)?;
    records::publish_signed(&state.pkarr, &public_key_z32, &payload).await
}

#[tauri::command]
pub async fn resolve_records(
    state: State<'_, AppState>,
    public_key_z32: String,
    background: Option<bool>,
    urgent: Option<bool>,
) -> Result<Option<ResolvedPacket>, String> {
    records::resolve(
        &state.pkarr,
        &public_key_z32,
        background.unwrap_or(false),
        urgent.unwrap_or(false),
    )
    .await
}

/// A line for the app's log (see `diagnostics`): the peer in the WebView says how a link is doing.
#[tauri::command]
pub fn diagnostic_log(line: String) {
    let line: String = line.chars().take(2_000).collect();
    diagnostics::log(&line);
}

#[tauri::command]
pub async fn local_fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
) -> Result<LocalResponse, String> {
    local_fetch::fetch(url, method, headers, body_b64).await
}

/// One call to the wallet RPC of the user's Bitcoin Core node: only the methods
/// the on-chain source needs, see `bitcoind_rpc`.
#[tauri::command]
pub async fn bitcoind_rpc(
    url: String,
    wallet: String,
    user: String,
    password: String,
    method: String,
    params: Vec<serde_json::Value>,
) -> Result<serde_json::Value, RpcError> {
    bitcoind_rpc::call(url, wallet, user, password, method, params).await
}

/// One call to the person's LND node for the LND Lightning source; see lnd.rs.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lnd_request(
    url: String,
    macaroon: String,
    certificate: Option<String>,
    method: String,
    path: String,
    body: Option<String>,
    stream: Option<String>,
    timeout_ms: u64,
) -> Result<LndResponse, String> {
    lnd::request(LndRequest {
        url,
        macaroon,
        certificate,
        method,
        path,
        body,
        stream,
        timeout_ms,
    })
    .await
}

#[tauri::command]
pub fn open_service_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    peer: String,
    service: String,
    title: String,
) -> Result<(), String> {
    viewer::open(&app, peer, service, title)
}

#[tauri::command]
pub fn service_respond<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: u64,
    response: ServiceResponse,
) {
    viewer::respond(&app, id, response);
}

/// Whether the updater can replace this install in place. It can on macOS and
/// Windows, and on Linux only for the AppImage: a `.deb` or `.rpm` belongs to
/// the package manager that put it there, so those are sent to the download
/// instead of a button that would fail.
#[tauri::command]
pub fn updater_can_install() -> bool {
    if cfg!(target_os = "linux") {
        env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

/// A `lightning:` or `bitcoin:` payment link, handed to whatever wallet the system has for it. Nothing
/// else: only those two schemes, only the characters a payment URI is made of, and never a file or a
/// web page.
#[tauri::command]
pub fn open_payment_link(url: String) -> Result<(), String> {
    if !is_payment_link(&url) {
        return Err("Not a payment link".into());
    }
    launch(&url)
}

fn is_payment_link(url: &str) -> bool {
    let scheme_ok = url.starts_with("lightning:") || url.starts_with("bitcoin:");
    let chars_ok = url.len() <= 4096
        && url
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"?=&%.:_-".contains(&c));
    scheme_ok && chars_ok
}

/// Opens a URL with the system's handler for it. Callers decide what may be opened.
fn launch(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    // The opener exits at once; waiting for it keeps no zombie behind until the app quits.
    result
        .map(|mut child| drop(std::thread::spawn(move || child.wait())))
        .map_err(|e| e.to_string())
}

/// Pubky Passport's authorize page, in the system browser: an identity proof's Pubky request, which Passport
/// approves (WISP 302). Only `https://passport.pubky.app/authorize#d=<the request, URI-encoded>`: no query, no
/// other page or host. The request is a short-lived secret; it is handed to the browser and never logged.
#[tauri::command]
pub fn open_pubky_passport(url: String) -> Result<(), String> {
    if !is_pubky_passport_url(&url) {
        return Err("Not a Pubky Passport request".into());
    }
    launch(&url)
}

fn is_pubky_passport_url(url: &str) -> bool {
    const PREFIX: &str = "https://passport.pubky.app/authorize#d=";
    let Some(request) = url.strip_prefix(PREFIX) else {
        return false;
    };
    // encodeURIComponent's output only: letters, digits, -_.!~*'() and %XX escapes. Nothing a shell or the
    // system's URL handler could read as a second argument, and no second fragment.
    !request.is_empty()
        && url.len() <= 8192
        && request
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.!~*'()%".contains(&c))
        && request.to_ascii_lowercase().starts_with("pubkyauth%3a")
}

/// Open only Ghostly's repository/release pages, in the system browser.
#[tauri::command]
pub fn open_project_link(url: String) -> Result<(), String> {
    if !is_project_link(&url) {
        return Err("Not a Ghostly project link".into());
    }
    launch(&url)
}

fn is_project_link(url: &str) -> bool {
    let root = "https://github.com/MiguelMedeiros/ghostly";
    url == root
        || url == format!("{root}/releases")
        || url
            .strip_prefix(&format!("{root}/releases/tag/"))
            .is_some_and(|tag| {
                !tag.is_empty()
                    && tag
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
            })
}

#[cfg(test)]
mod project_link_tests {
    // covers: app.project-links, desktop.payment-links
    #[test]
    fn rejects_links_outside_the_project_before_launching_anything() {
        for url in [
            "https://example.com",
            "file:///etc/passwd",
            "https://github.com/MiguelMedeiros/ghostly.evil/releases",
            "https://github.com/MiguelMedeiros/ghostly/releases/tag/../../other",
            "https://github.com/MiguelMedeiros/ghostly/releases/tag/v1?redirect=evil",
        ] {
            assert!(super::open_project_link(url.into()).is_err());
        }
    }

    #[test]
    fn rejects_payment_links_that_are_not_lightning_or_bitcoin_uris() {
        for url in [
            "https://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "lightning:lnbc1 ; rm -rf /",
            "bitcoin:bc1q?label=<script>",
            "LIGHTNING:LNBC1",
            "",
        ] {
            assert!(super::open_payment_link(url.into()).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    // covers: desktop.crypto, desktop.payment-links, app.project-links, chat.dht.delivery, proofs.pubky
    use super::*;
    use crate::test_support::{pkarr, pkarr_relay, Relay};
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::Manager;

    #[test]
    fn payment_links_are_lightning_or_bitcoin_uris_made_of_payment_characters() {
        let longest = format!("lightning:{}", "a".repeat(4096 - "lightning:".len()));
        for url in [
            "lightning:lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq",
            "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.0001&label=Coffee%20shop&lightning=lnbc1x",
            "bitcoin:BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ?ark=tark1q",
            longest.as_str(),
            // Nothing after the scheme opens only the wallet (the extension asks for one character more).
            "lightning:",
        ] {
            assert!(is_payment_link(url), "{url}");
        }
        let too_long = format!("{longest}a");
        for url in [
            too_long.as_str(),
            "lightning:lnbc1/../x",
            "bitcoin:bc1q#fragment",
            "bitcoin:bc1q x",
            "bitcoin:bc1q\n",
            "lightning:lnbc1;open -a Calculator",
            "bitcoin:bc1q+x",
            "bitcoin:bc1q@evil.example",
            "lightning:lnbc1'\"",
            " lightning:lnbc1",
            "web+lightning:lnbc1",
            "lightningx:lnbc1",
            "lightning:lnbç",
        ] {
            assert!(!is_payment_link(url), "{url}");
        }
    }

    #[test]
    fn pubky_passport_opens_only_its_authorize_page_with_a_request() {
        let request = "pubkyauth%3A%2F%2Fsignin%3Fcaps%3D%252Fpub%252Fghostly.app%252Fproofs%252Fab%252F%253Aw%26secret%3DAbC-_";
        let ok = format!("https://passport.pubky.app/authorize#d={request}");
        assert!(is_pubky_passport_url(&ok), "{ok}");
        for url in [
            "https://passport.pubky.app/authorize#d=".to_string(),
            format!("https://passport.pubky.app/authorize?x=1#d={request}"),
            format!("http://passport.pubky.app/authorize#d={request}"),
            format!("https://passport.pubky.app.evil.example/authorize#d={request}"),
            format!("https://passport.pubky.app/other#d={request}"),
            format!("https://evil.example/#https://passport.pubky.app/authorize#d={request}"),
            format!("https://passport.pubky.app/authorize#d={request}#x"),
            format!("https://passport.pubky.app/authorize#d={request} --args"),
            format!("https://passport.pubky.app/authorize#d={request}\n"),
            "https://passport.pubky.app/authorize#d=https%3A%2F%2Fevil.example".to_string(),
            format!(
                "https://passport.pubky.app/authorize#d={}",
                "a".repeat(9000)
            ),
        ] {
            assert!(!is_pubky_passport_url(&url), "{url}");
            assert!(super::open_pubky_passport(url).is_err());
        }
    }

    #[test]
    fn project_links_are_the_repository_its_releases_or_one_tag() {
        let root = "https://github.com/MiguelMedeiros/ghostly";
        for url in [
            root.to_string(),
            format!("{root}/releases"),
            format!("{root}/releases/tag/v0.4.0"),
            format!("{root}/releases/tag/ghostly-v1.2_3"),
        ] {
            assert!(is_project_link(&url), "{url}");
        }
        for url in [
            format!("{root}/"),
            format!("{root}/releases/"),
            format!("{root}/releases/tag/"),
            format!("{root}/releases/tag/v1/x"),
            format!("{root}/releases/tag/v1%2F..%2Fx"),
            format!("{root}/issues"),
            format!("{root}#x"),
            "http://github.com/MiguelMedeiros/ghostly".into(),
            "https://GITHUB.com/MiguelMedeiros/ghostly".into(),
            "https://github.com/MiguelMedeiros/ghostly2".into(),
        ] {
            assert!(!is_project_link(&url), "{url}");
        }
    }

    #[test]
    fn a_seed_is_32_bytes_of_base64url_and_gives_its_public_key_back() {
        let pair = create_keypair().unwrap();
        assert_eq!(pair.pub_key_z32.len(), 52);
        assert_eq!(
            get_public_key(pair.seed_b64.clone()).unwrap(),
            pair.pub_key_z32
        );
        assert_ne!(create_keypair().unwrap().seed_b64, pair.seed_b64);
        for seed in [
            String::new(),
            "not base64!".into(),
            crypto::to_base64_url(&[1; 31]),
            crypto::to_base64_url(&[1; 33]),
            STANDARD.encode([1u8; 32]),
        ] {
            assert!(get_public_key(seed.clone()).is_err(), "{seed}");
        }
    }

    #[test]
    fn text_is_sealed_under_a_32_byte_key_and_only_that_key_opens_it() {
        let key = generate_enc_key();
        assert_eq!(crypto::from_base64_url(&key).unwrap().len(), 32);
        assert_ne!(key, generate_enc_key());

        let sealed = encrypt_text("olá 👻".into(), key.clone()).unwrap();
        assert_ne!(
            sealed,
            encrypt_text("olá 👻".into(), key.clone()).unwrap(),
            "a fresh nonce every time"
        );
        assert_eq!(decrypt_text(sealed.clone(), key.clone()).unwrap(), "olá 👻");
        assert!(decrypt_text(sealed.clone(), generate_enc_key()).is_err());

        let mut tampered = STANDARD.decode(&sealed).unwrap();
        tampered[30] ^= 1;
        assert!(decrypt_text(STANDARD.encode(tampered), key.clone()).is_err());
        assert_eq!(
            decrypt_text(STANDARD.encode([0u8; 24]), key.clone()).unwrap_err(),
            "Invalid ciphertext: too short"
        );
        assert!(decrypt_text("%%%".into(), key.clone()).is_err());
        assert!(encrypt_text("x".into(), crypto::to_base64_url(&[0; 16]))
            .unwrap_err()
            .contains("Invalid key length"));
        assert!(encrypt_text("x".into(), "not a key!".into()).is_err());
    }

    #[test]
    fn the_updater_replaces_only_installs_it_owns() {
        // Read, never set: another test thread may be resolving a host, and
        // setenv under getaddrinfo is not safe on Linux.
        let expected = !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some();
        assert_eq!(updater_can_install(), expected);
    }

    fn app(relay: &Relay) -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(AppState {
                pkarr: pkarr(relay),
            })
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn record(label: &str, value: &str, ttl: Option<u32>) -> RecordInput {
        RecordInput {
            label: label.into(),
            value: value.into(),
            ttl,
        }
    }

    #[tokio::test]
    async fn records_are_signed_published_and_resolved_as_given() {
        let relay = pkarr_relay().await;
        let app = app(&relay);
        let pair = create_keypair().unwrap();
        publish_records(
            app.state(),
            pair.seed_b64.clone(),
            vec![
                record("_ghostly", "v=1", None),
                record("_svc", &"x".repeat(200), Some(60)),
            ],
        )
        .await
        .unwrap();
        assert!(relay
            .packets
            .lock()
            .unwrap()
            .contains_key(&pair.pub_key_z32));

        let packet = resolve_records(app.state(), pair.pub_key_z32.clone(), None, None)
            .await
            .unwrap()
            .expect("the packet");
        let records: Vec<_> = packet
            .records
            .iter()
            .map(|r| (r.label.as_str(), r.value.len(), r.ttl))
            .collect();
        assert_eq!(records, [("_ghostly", 3, 300), ("_svc", 200, 60)]);
        assert!(packet.timestamp_micros.parse::<u64>().unwrap() > 0);

        // Nobody published under this key: nothing, not an error.
        let stranger = create_keypair().unwrap().pub_key_z32;
        assert!(resolve_records(app.state(), stranger, None, None)
            .await
            .unwrap()
            .is_none());
        assert!(resolve_records(app.state(), "not-a-key".into(), None, None)
            .await
            .unwrap_err()
            .contains("Invalid public key"));
    }

    /// A did:dht document the TypeScript peer signed (`@ghostly/core` `signDidDhtPacket`, a test key of
    /// 32 bytes of 7, sequence 1790000000 in seconds, `alsoKnownAs` https://example.com).
    const DID_DHT_KEY: &str = "7jfgaa9nutjyixzikb7tgmsf9gkwq7iqz498zr1nd5ig1fng4esy";
    const DID_DHT_PAYLOAD: &str = "0WTnPoxBDJihtEjzeQUO2F8qDeiUKB7Ej_QLTuEt7QZUvR-ZuIum3Kd1NgzKTKeECmUmbSJbu73iQ0WHq1yZAQAAAABqsTuAAACEAAAAAAMAAAAABF9ha2EEX2RpZAAAEAABAAAcIAAUE2h0dHBzOi8vZXhhbXBsZS5jb20DX2swwBEAEAABAAAcIAAyMXQ9MDtrPTZrcHNZLUtjVWdxLTlWQjdFeTdGLVpWSGRxNi12bnVTUWg3cWFSUkcwaXcEX2RpZDQ3amZnYWE5bnV0anlpeHppa2I3dGdtc2Y5Z2t3cTdpcXo0OTh6cjFuZDVpZzFmbmc0ZXN5AAAQAAEAABwgACcmdj0wO3ZtPWswO2F1dGg9azA7YXNtPWswO2ludj1rMDtkZWw9azA";

    #[tokio::test]
    async fn a_packet_signed_in_the_webview_is_published_byte_for_byte() {
        let relay = pkarr_relay().await;
        let app = app(&relay);
        publish_signed_packet(app.state(), DID_DHT_KEY.into(), DID_DHT_PAYLOAD.into())
            .await
            .unwrap();
        let payload = crypto::from_base64_url(DID_DHT_PAYLOAD).unwrap();
        assert_eq!(
            relay.packets.lock().unwrap().get(DID_DHT_KEY),
            Some(&payload)
        );

        // Its sequence number (seconds) and its names (`_k0._did`, `_did.<key>`) come back unchanged.
        let packet = resolve_records(app.state(), DID_DHT_KEY.into(), None, None)
            .await
            .unwrap()
            .expect("the packet");
        assert_eq!(packet.timestamp_micros, "1790000000");
        let labels: Vec<_> = packet.records.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, ["_aka", "_k0", "_did"]);

        // Someone else's key, or a byte changed: refused before anything is sent.
        let other = create_keypair().unwrap().pub_key_z32;
        assert!(
            publish_signed_packet(app.state(), other, DID_DHT_PAYLOAD.into())
                .await
                .unwrap_err()
                .contains("Invalid packet")
        );
        let mut tampered = payload.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(publish_signed_packet(
            app.state(),
            DID_DHT_KEY.into(),
            crypto::to_base64_url(&tampered)
        )
        .await
        .unwrap_err()
        .contains("Invalid packet"));
        assert_eq!(relay.packets.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_bad_seed_or_record_never_reaches_the_relay() {
        let relay = pkarr_relay().await;
        let app = app(&relay);
        let short = crypto::to_base64_url(&[7; 31]);
        assert_eq!(
            publish_records(app.state(), short.clone(), vec![])
                .await
                .unwrap_err(),
            "Seed must be exactly 32 bytes"
        );
        let seed = create_keypair().unwrap().seed_b64;
        assert!(publish_records(
            app.state(),
            seed.clone(),
            vec![record(&"a".repeat(64), "v", None)]
        )
        .await
        .unwrap_err()
        .contains("Name error"));
        // More than a signed packet holds (1000 bytes of DNS).
        assert!(publish_records(
            app.state(),
            seed,
            (0..8)
                .map(|i| record(&format!("_r{i}"), &"v".repeat(200), None))
                .collect()
        )
        .await
        .unwrap_err()
        .contains("Sign error"));
        let key = generate_enc_key();
        assert!(
            publish_messages(app.state(), short, vec![], key.clone(), 0, None, None)
                .await
                .is_err()
        );
        assert!(relay.requests.lock().unwrap().is_empty());
    }

    fn message(t: i64, m: &str) -> CompactMessage {
        CompactMessage { t, m: m.into() }
    }

    #[tokio::test]
    async fn messages_round_trip_with_their_ack_nick_and_call_signal() {
        let relay = pkarr_relay().await;
        let app = app(&relay);
        let alice = create_keypair().unwrap();
        let key = generate_enc_key();
        let kept = publish_messages(
            app.state(),
            alice.seed_b64.clone(),
            vec![message(2_000, "second"), message(1_000, "first")],
            key.clone(),
            77,
            Some("Alice".into()),
            Some("offer".into()),
        )
        .await
        .unwrap();
        assert_eq!(kept, 2);

        let batch = resolve_messages(app.state(), alice.pub_key_z32.clone(), key.clone())
            .await
            .unwrap()
            .unwrap();
        let texts: Vec<_> = batch
            .messages
            .iter()
            .map(|m| (m.text.as_str(), m.timestamp, m.nick.as_deref()))
            .collect();
        assert_eq!(
            texts,
            [
                ("first", 1_000, Some("Alice")),
                ("second", 2_000, Some("Alice"))
            ]
        );
        assert_eq!(
            (batch.latest_timestamp, batch.peer_ack, batch.message_count),
            (2_000, 77, 2)
        );
        assert_eq!(batch.call_signal.as_deref(), Some("offer"));
        let mut names = batch.raw_record_names.clone();
        names.sort();
        assert_eq!(names, ["_ack", "_call", "_msgs", "_nick", "_ts"]);

        // Under another key the records are there and say nothing.
        let stranger = resolve_messages(app.state(), alice.pub_key_z32, generate_enc_key())
            .await
            .unwrap()
            .unwrap();
        assert!(stranger.messages.is_empty());
        assert_eq!((stranger.call_signal, stranger.peer_ack), (None, 77));
    }

    #[tokio::test]
    async fn a_batch_keeps_the_newest_messages_that_fit_one_record() {
        let relay = pkarr_relay().await;
        let app = app(&relay);
        let alice = create_keypair().unwrap();
        let key = generate_enc_key();
        let many: Vec<_> = (1..=30)
            .map(|i| message(i, &format!("message number {i:02} {}", "x".repeat(20))))
            .collect();
        let kept = publish_messages(
            app.state(),
            alice.seed_b64.clone(),
            many,
            key.clone(),
            0,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(kept > 0 && kept < 30, "{kept}");
        let batch = resolve_messages(app.state(), alice.pub_key_z32.clone(), key.clone())
            .await
            .unwrap()
            .unwrap();
        let first = 30 - kept as i64 + 1;
        assert_eq!(
            batch
                .messages
                .iter()
                .map(|m| m.timestamp)
                .collect::<Vec<_>>(),
            (first..=30).collect::<Vec<_>>(),
            "the oldest are dropped"
        );
        assert!(!batch.raw_record_names.contains(&"_ack".to_string()));
        assert_eq!(batch.message_count, kept);

        // One message too long for a record is cut to its first 400 characters.
        let kept = publish_messages(
            app.state(),
            alice.seed_b64,
            vec![message(99, &"y".repeat(2_000))],
            key.clone(),
            0,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(kept, 1);
        let batch = resolve_messages(app.state(), alice.pub_key_z32, key)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(batch.messages[0].text, "y".repeat(400));
    }

    #[tokio::test]
    async fn a_long_message_in_any_script_is_cut_until_it_fits() {
        let relay = pkarr_relay().await;
        let app = app(&relay);
        let alice = create_keypair().unwrap();
        let key = generate_enc_key();
        for text in [
            "é".repeat(2_000),
            "👻".repeat(2_000),
            "\"".repeat(2_000),
            "日本語".repeat(700),
        ] {
            let kept = publish_messages(
                app.state(),
                alice.seed_b64.clone(),
                vec![message(1, &text)],
                key.clone(),
                0,
                None,
                None,
            )
            .await
            .unwrap_or_else(|error| panic!("{}: {error}", &text[..8]));
            assert_eq!(kept, 1);
            let batch = resolve_messages(app.state(), alice.pub_key_z32.clone(), key.clone())
                .await
                .unwrap()
                .unwrap();
            let got = &batch.messages[0].text;
            assert!(!got.is_empty() && text.starts_with(got.as_str()), "{got}");
        }
    }
}
