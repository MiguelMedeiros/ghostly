//! A Pubky cookie session's requests to the homeserver, made here instead of in the WebView.
//!
//! Pubky Ring approves the cookie kind of Pubky auth request: the homeserver answers the
//! session request with a session cookie (`HttpOnly; SameSite=None; Secure`), and the writes
//! that follow are authorized by that cookie alone. For the page that cookie is a third-party
//! one, and WKWebView drops it, so every write was refused. Here each approval gets its own
//! cookie jar, which never leaves Rust (the page never sees a `Set-Cookie`), and is forgotten
//! when the page closes the session.
//!
//! Only what a cookie session needs goes through: its `/session` and its files (`/storage/…`, `/pub/…`),
//! over HTTPS (plain HTTP to this machine only, for the tests), no redirects, a small answer.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;

/// A proof is a few hundred bytes; a session's answers are small too.
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Sessions open at once: one approval has one, and a closed one is dropped.
const MAX_SESSIONS: usize = 8;

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_b64: String,
}

/// One approval's cookies: origin → cookie name → value.
type Jar = HashMap<String, HashMap<String, String>>;

fn sessions() -> &'static Mutex<HashMap<String, Jar>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Jar>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    Ok(CLIENT.get_or_init(|| client))
}

fn valid_session(session: &str) -> bool {
    (16..=64).contains(&session.len())
        && session
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// A homeserver address a cookie session uses: its session, or a file of its storage (`/storage/<key>/pub/…`,
/// or `/pub/…` with a `pubky-host` header where the homeserver does not address storage by path).
fn allowed(url: &reqwest::Url) -> bool {
    let transport = url.scheme() == "https" || (url.scheme() == "http" && is_loopback(url));
    let path = url.path();
    transport
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (path == "/session" || path.starts_with("/storage/") || path.starts_with("/pub/"))
        && !path.split('/').any(|segment| segment == "..")
}

fn origin(url: &reqwest::Url) -> String {
    url.origin().ascii_serialization()
}

/// What a `Set-Cookie` does to the jar: the cookie, or `None` when it removes one.
fn set_cookie(value: &str) -> Option<(String, Option<String>)> {
    let cookie = cookie::Cookie::parse(value.to_string()).ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let expired = cookie.max_age().is_some_and(|age| age.whole_seconds() <= 0)
        || cookie
            .expires_datetime()
            .is_some_and(|at| at.unix_timestamp() <= now)
        || cookie.value().is_empty();
    let name = cookie.name().to_string();
    Some((name, (!expired).then(|| cookie.value().to_string())))
}

/// One request of the cookie session `session`, with the cookies the homeserver gave it.
pub async fn fetch(
    session: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
) -> Result<SessionResponse, String> {
    if !valid_session(&session) {
        return Err("Invalid session".into());
    }
    let url = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !allowed(&url) {
        return Err("Not a Pubky homeserver session request".into());
    }
    let method = match method.as_str() {
        "GET" | "HEAD" | "PUT" | "POST" | "DELETE" => {
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid method")?
        }
        _ => return Err("Invalid method".into()),
    };
    let body = body_b64
        .map(|b| STANDARD.decode(b).map_err(|e| format!("Body: {}", e)))
        .transpose()?;
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY_BYTES) {
        return Err("Body too large".into());
    }

    let origin = origin(&url);
    let cookies = {
        let mut sessions = sessions().lock().unwrap();
        if !sessions.contains_key(&session) && sessions.len() >= MAX_SESSIONS {
            return Err("Too many Pubky sessions".into());
        }
        let jar = sessions.entry(session.clone()).or_default();
        jar.get(&origin)
            .map(|cookies| {
                let mut pairs: Vec<_> = cookies.iter().map(|(n, v)| format!("{n}={v}")).collect();
                pairs.sort();
                pairs.join("; ")
            })
            .unwrap_or_default()
    };

    let mut request = client()?.request(method, url);
    for (name, value) in headers {
        // The jar's cookies only, and the address's own host.
        if ["cookie", "host", "content-length"].contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        request = request.header(name, value);
    }
    if !cookies.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let mut response = request
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", e.without_url()))?;
    let status = response.status().as_u16();
    let set: Vec<_> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| set_cookie(value.to_str().ok()?))
        .collect();
    let headers = response
        .headers()
        .iter()
        .filter(|(name, _)| *name != reqwest::header::SET_COOKIE)
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();

    // A session closed while its request was out keeps nothing.
    if let Some(jar) = sessions().lock().unwrap().get_mut(&session) {
        let cookies = jar.entry(origin).or_default();
        for (name, value) in set {
            match value {
                Some(value) => cookies.insert(name, value),
                None => cookies.remove(&name),
            };
        }
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Body: {}", e))? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(SessionResponse {
        status,
        headers,
        body_b64: STANDARD.encode(body),
    })
}

/// Forgets the session's cookies.
pub fn close(session: String) {
    sessions().lock().unwrap().remove(&session);
}

#[cfg(test)]
mod tests {
    // covers: proofs.pubky
    use super::*;
    use crate::test_support::{read_request, respond, tokio_listener, Requests};

    /// A homeserver stand-in: `POST /session` sets the session cookie, `/storage/…` needs it, and
    /// `DELETE /session` clears it. Returns its address and the requests it saw.
    fn homeserver() -> (String, Requests) {
        let listener = tokio_listener();
        let address = listener.local_addr().unwrap();
        let seen = Requests::default();
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let Some((head, body)) = read_request(&mut stream).await else {
                    continue;
                };
                log.lock().unwrap().push((head.clone(), body));
                let line = head.lines().next().unwrap_or_default().to_string();
                let authorized = head
                    .lines()
                    .any(|l| l.eq_ignore_ascii_case("cookie: owner=s3cret"));
                if line.starts_with("POST /session ") {
                    respond(
                        &mut stream,
                        "200 OK",
                        &[
                            (
                                "Set-Cookie",
                                "owner=s3cret; HttpOnly; Secure; SameSite=None; Path=/",
                            ),
                            ("Content-Type", "application/octet-stream"),
                        ],
                        b"session",
                    )
                    .await;
                } else if line.starts_with("DELETE /session ") && authorized {
                    respond(
                        &mut stream,
                        "200 OK",
                        &[("Set-Cookie", "owner=; Max-Age=0; Path=/")],
                        b"",
                    )
                    .await;
                } else if line.contains(" /storage/") && authorized {
                    respond(&mut stream, "201 Created", &[], b"").await;
                } else {
                    respond(&mut stream, "401 Unauthorized", &[], b"no session").await;
                }
            }
        });
        (format!("http://{address}"), seen)
    }

    fn id(n: u8) -> String {
        format!("session-{n:0>12}")
    }

    #[tokio::test]
    async fn a_cookie_session_writes_with_the_cookie_the_page_never_sees() {
        let (url, seen) = homeserver();
        let session = id(1);
        let signin = fetch(
            session.clone(),
            format!("{url}/session"),
            "POST".into(),
            vec![("pubky-host".into(), "owner".into())],
            Some(STANDARD.encode(b"token")),
        )
        .await
        .unwrap();
        assert_eq!(signin.status, 200);
        assert!(
            signin.headers.iter().all(|(n, _)| n != "set-cookie"),
            "{:?}",
            signin.headers
        );
        assert_eq!(STANDARD.decode(signin.body_b64).unwrap(), b"session");

        let put = fetch(
            session.clone(),
            format!("{url}/storage/owner/pub/ghostly.app/proofs/f/a.txt"),
            "PUT".into(),
            vec![("content-type".into(), "text/plain".into())],
            Some(STANDARD.encode(b"proof")),
        )
        .await
        .unwrap();
        assert_eq!(put.status, 201);

        // Another approval has its own jar: no cookie, refused.
        let other = fetch(
            id(2),
            format!("{url}/storage/owner/pub/x.txt"),
            "PUT".into(),
            vec![],
            Some(STANDARD.encode(b"x")),
        )
        .await
        .unwrap();
        assert_eq!(other.status, 401);
        close(id(2));

        // Signing out clears the cookie; the jar is empty after that.
        assert_eq!(
            fetch(
                session.clone(),
                format!("{url}/session"),
                "DELETE".into(),
                vec![],
                None
            )
            .await
            .unwrap()
            .status,
            200
        );
        assert_eq!(
            fetch(
                session.clone(),
                format!("{url}/storage/owner/pub/x.txt"),
                "PUT".into(),
                vec![],
                None
            )
            .await
            .unwrap()
            .status,
            401
        );
        close(session.clone());

        let requests = seen.lock().unwrap().clone();
        let (head, body) = &requests[0];
        assert!(head.starts_with("POST /session HTTP/1.1"), "{head}");
        assert!(head.to_ascii_lowercase().contains("pubky-host: owner"));
        assert_eq!(body, b"token");
        assert!(
            requests[1].0.contains("cookie: owner=s3cret"),
            "{}",
            requests[1].0
        );
        assert_eq!(requests[1].1, b"proof");
        assert!(!requests[2].0.to_ascii_lowercase().contains("cookie:"));
        assert!(!requests[4].0.to_ascii_lowercase().contains("cookie:"));
    }

    #[tokio::test]
    async fn a_cookie_the_page_sends_is_not_forwarded() {
        let (url, seen) = homeserver();
        let answer = fetch(
            id(3),
            format!("{url}/storage/owner/pub/x.txt"),
            "PUT".into(),
            vec![("Cookie".into(), "owner=s3cret".into())],
            None,
        )
        .await
        .unwrap();
        assert_eq!(answer.status, 401);
        close(id(3));
        assert!(!seen.lock().unwrap()[0]
            .0
            .to_ascii_lowercase()
            .contains("cookie:"));
    }

    #[tokio::test]
    async fn only_a_homeserver_session_or_storage_address_over_https() {
        for url in [
            "https://homeserver.example/info",
            "https://homeserver.example/",
            "https://homeserver.example/storage/../admin",
            "https://homeserver.example/auth/grant/session",
            "https://user:pw@homeserver.example/session",
            "http://homeserver.example/session",
            "http://10.0.0.1/session",
            "ftp://127.0.0.1/session",
            "file:///session",
            "not a url",
        ] {
            let error = fetch(id(4), url.into(), "GET".into(), vec![], None)
                .await
                .unwrap_err();
            assert!(
                error == "Not a Pubky homeserver session request"
                    || error.starts_with("Invalid URL"),
                "{url}: {error}"
            );
        }
        for method in ["PATCH", "OPTIONS", "CONNECT", "GE T"] {
            let error = fetch(
                id(4),
                "https://homeserver.example/session".into(),
                method.into(),
                vec![],
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(error, "Invalid method");
        }
        assert_eq!(
            fetch(
                "short".into(),
                "https://homeserver.example/session".into(),
                "GET".into(),
                vec![],
                None
            )
            .await
            .unwrap_err(),
            "Invalid session"
        );
        assert_eq!(
            fetch(
                id(4),
                "https://homeserver.example/session".into(),
                "POST".into(),
                vec![],
                Some(STANDARD.encode(vec![0u8; MAX_BODY_BYTES + 1]))
            )
            .await
            .unwrap_err(),
            "Body too large"
        );
        assert!(sessions().lock().unwrap().get(&id(4)).is_none());

        // What the SDK asks for: the session, and files addressed by path or by `pubky-host`.
        for url in [
            "https://homeserver.example/session",
            "https://homeserver.example/storage/owner/pub/ghostly.app/proofs/f/a.txt",
            "https://homeserver.example/pub/ghostly.app/proofs/f/a.txt",
            "http://127.0.0.1:6286/session",
        ] {
            assert!(allowed(&reqwest::Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn a_set_cookie_that_expires_removes_the_cookie() {
        assert_eq!(
            set_cookie("a=1; Path=/"),
            Some(("a".into(), Some("1".into())))
        );
        assert_eq!(set_cookie("a=1; Max-Age=0"), Some(("a".into(), None)));
        assert_eq!(
            set_cookie("a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
            Some(("a".into(), None))
        );
        assert_eq!(set_cookie("a="), Some(("a".into(), None)));
        assert_eq!(set_cookie("garbage"), None);
    }
}
