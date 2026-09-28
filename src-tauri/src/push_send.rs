//! Wake-up push (WISP 401 § Wake-up push): posts a wake-up, already encrypted and signed by the engine, to the
//! push service a contact's web app shared. A page may not post it itself (push services answer without CORS);
//! Rust has no CORS, so a Desktop sender needs no relay. Only an https push service on a public host name,
//! only the Web Push headers, a small body, no redirect, and the status back: nothing else is read.

use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::link_preview::PublicOnly;

/// A wake-up is a few hundred bytes; this is generous.
const MAX_BODY: usize = 8 * 1024;
/// The headers Web Push needs. Anything else the engine passed is dropped.
const HEADERS: [&str; 6] = [
    "authorization",
    "ttl",
    "urgency",
    "topic",
    "content-encoding",
    "content-type",
];

/// Where a push may go: https, no credentials, a host name that is not local.
pub fn check_endpoint(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("The push endpoint is not https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The push endpoint carries credentials".into());
    }
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.to_ascii_lowercase();
            if !domain.contains('.')
                || domain == "localhost"
                || domain.ends_with(".localhost")
                || domain.ends_with(".local")
            {
                return Err("The push endpoint is not a public host name".into());
            }
            Ok(())
        }
        _ => Err("The push endpoint is not a public host name".into()),
    }
}

/// The headers that go: the Web Push ones, without line breaks, bounded.
pub fn allowed_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(name, value)| {
            HEADERS.contains(&name.to_ascii_lowercase().as_str())
                && value.len() < 2048
                && !value.contains(['\r', '\n'])
        })
        .collect()
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        // The name must resolve to public addresses only, whatever the endpoint says.
        .dns_resolver(PublicOnly)
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// One POST; answers the push service's status (201 taken, 404 or 410 gone).
pub async fn send(
    url: String,
    headers: Vec<(String, String)>,
    body_b64: String,
) -> Result<u16, String> {
    let url =
        reqwest::Url::parse(&url).map_err(|_| "The push endpoint is not a URL".to_string())?;
    check_endpoint(&url)?;
    let body = URL_SAFE_NO_PAD
        .decode(body_b64.as_bytes())
        .map_err(|_| "The body is not base64url".to_string())?;
    if body.len() > MAX_BODY {
        return Err("The push is too large".into());
    }
    let mut request = client()?.post(url).body(body);
    for (name, value) in allowed_headers(headers) {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", e.without_url()))?;
    Ok(response.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> reqwest::Url {
        reqwest::Url::parse(text).unwrap()
    }

    #[test]
    fn only_public_https_push_services() {
        for good in [
            "https://fcm.googleapis.com/fcm/send/x",
            "https://web.push.apple.com/QAB",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
        ] {
            assert!(check_endpoint(&url(good)).is_ok(), "{good}");
        }
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://localhost/x",
            "https://printer.local/x",
            "https://intranet/x",
            "https://u:p@push.example.com/x",
        ] {
            assert!(check_endpoint(&url(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_web_push_headers() {
        let kept = allowed_headers(vec![
            ("Authorization".into(), "vapid t=x, k=y".into()),
            ("TTL".into(), "3600".into()),
            ("Cookie".into(), "secret".into()),
            ("Urgency".into(), "high\r\nX-Evil: 1".into()),
            ("Host".into(), "elsewhere.example".into()),
        ]);
        assert_eq!(
            kept,
            vec![
                ("Authorization".to_string(), "vapid t=x, k=y".to_string()),
                ("TTL".to_string(), "3600".to_string())
            ]
        );
    }
}
