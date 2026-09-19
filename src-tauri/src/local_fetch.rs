//! Requests to a web app the user shares from this machine.
//!
//! The WebView cannot make them: its content security policy and CORS both say
//! no. Which service maps to which address is decided by the peer; this side
//! refuses anything that is not loopback and never follows a redirect, so a
//! request can only ever reach this machine.

use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;

const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
pub struct LocalResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_b64: String,
}

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// One client for every request: a client per request means a connection pool
/// and TLS setup per request, which a peer can make the host pay for at will.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        // Never follow: a redirect could point anywhere, and the peer side
        // decides what to do with an on-target one.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    Ok(CLIENT.get_or_init(|| client))
}

pub async fn fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
) -> Result<LocalResponse, String> {
    let url = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !matches!(url.scheme(), "http" | "https") || !is_loopback(&url) {
        return Err("Only services on this machine can be shared".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid method")?;

    let mut request = client()?.request(method, url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body_b64 {
        request = request.body(STANDARD.decode(body).map_err(|e| format!("Body: {}", e))?);
    }

    let mut response = request
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", e))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Body: {}", e))? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Response too large".into());
        }
        body.extend_from_slice(&chunk);
    }

    Ok(LocalResponse {
        status,
        headers,
        body_b64: STANDARD.encode(body),
    })
}
