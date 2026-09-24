//! Signing in with an OpenID Connect provider from the desktop app.
//!
//! Providers block sign-in inside embedded WebViews, so the provider's page
//! opens in the system browser. It redirects to the web app's static callback
//! page, which forwards the answer (still in the fragment, never sent to a
//! server) to a listener here on 127.0.0.1. The listener accepts one answer
//! carrying the state the WebView expects, hands it back, and closes. It never
//! sees or keeps anything but that one redirect.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(10 * 60);
const MAX_REQUEST: usize = 32 * 1024;
const PATH: &str = "/oidc-callback";

struct Pending {
    listener: Option<TcpListener>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct OidcState(Mutex<HashMap<u16, Pending>>);

/// The page the browser lands on. The provider's answer is in its fragment,
/// which only a script can read; it posts it back to this same listener and
/// removes it from the browser's history entry.
const PAGE: &str = "<!doctype html><meta charset=utf-8><meta name=referrer content=no-referrer><title>Ghostly</title>\
<body style=\"font:16px system-ui;background:#050d14;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0\">\
<p id=m>Returning to Ghostly…</p><script>\
const a=location.search+location.hash;history.replaceState(null,'','/oidc-callback');\
fetch('/oidc-callback',{method:'POST',body:a,headers:{'content-type':'text/plain'}}).then(r=>{\
document.getElementById('m').textContent=r.ok?'Done. You can close this tab and return to Ghostly.':'This sign-in is no longer awaited. Return to Ghostly and try again.'})\
.catch(()=>{document.getElementById('m').textContent='Ghostly is not waiting for this sign-in anymore.'});\
</script>";

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Reads one request, headers and a body announced by Content-Length, within the size limit.
fn read_request(
    stream: &mut TcpStream,
) -> Option<(String, String, HashMap<String, String>, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_REQUEST {
            return None;
        }
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = std::str::from_utf8(&buf[..end]).ok()?.to_string();
            let mut lines = head.split("\r\n");
            let mut request = lines.next()?.split(' ');
            let method = request.next()?.to_string();
            let target = request.next()?.to_string();
            let headers: HashMap<String, String> = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect();
            let length: usize = headers
                .get("content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if end + 4 + length > MAX_REQUEST {
                return None;
            }
            while buf.len() < end + 4 + length {
                let n = stream.read(&mut chunk).ok()?;
                if n == 0 {
                    return None;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body = String::from_utf8(buf[end + 4..end + 4 + length].to_vec()).ok()?;
            return Some((method, target, headers, body));
        }
    }
}

/// The `state` in "?a=b#c=d" (query or fragment).
fn state_of(answer: &str) -> Option<String> {
    let (query, fragment) = answer.split_once('#').unwrap_or((answer, ""));
    [fragment, query.trim_start_matches('?')]
        .into_iter()
        .flat_map(|part| url::form_urlencoded::parse(part.as_bytes()).into_owned())
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v)
}

/// Serves the listener until an answer with `state` arrives, the wait ends, or it is cancelled.
pub fn serve(
    listener: &TcpListener,
    state: &str,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let host = format!("127.0.0.1:{port}");
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("Sign-in timed out. Try again.".into());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let Some((method, target, headers, body)) = read_request(&mut stream) else {
            continue;
        };
        // A page elsewhere reaching this port by a name that resolves here is refused.
        if headers.get("host").map(String::as_str) != Some(host.as_str()) {
            respond(&mut stream, "400 Bad Request", "text/plain", "Bad request");
            continue;
        }
        let path = target.split(['?', '#']).next().unwrap_or("");
        match (method.as_str(), path) {
            ("GET", PATH) => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE),
            ("POST", PATH) if state_of(&body).as_deref() == Some(state) => {
                respond(&mut stream, "200 OK", "text/plain", "OK");
                return Ok(body);
            }
            ("POST", PATH) => respond(&mut stream, "409 Conflict", "text/plain", "Not awaited"),
            _ => respond(&mut stream, "404 Not Found", "text/plain", "Not found"),
        }
    }
}

fn is_allowed_authorize_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"));
    parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query_pairs().any(|(k, _)| k == "redirect_uri")
        && (parsed.scheme() == "https"
            || (cfg!(debug_assertions) && parsed.scheme() == "http" && loopback))
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Listens on a free loopback port for one sign-in answer. Returns the port.
#[tauri::command]
pub fn oidc_loopback_start(state: tauri::State<'_, OidcState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    // One sign-in at a time: an abandoned one is dropped.
    for old in pending.values() {
        old.cancelled.store(true, Ordering::SeqCst);
    }
    pending.clear();
    pending.insert(
        port,
        Pending {
            listener: Some(listener),
            cancelled: Arc::new(AtomicBool::new(false)),
        },
    );
    Ok(port)
}

/// Opens the provider's page in the system browser and waits for the answer with `expected_state`.
#[tauri::command]
pub async fn oidc_loopback_wait(
    state: tauri::State<'_, OidcState>,
    port: u16,
    url: String,
    expected_state: String,
) -> Result<String, String> {
    if !is_allowed_authorize_url(&url) {
        return Err("Not a sign-in address".into());
    }
    if expected_state.len() < 43 || expected_state.len() > 64 {
        return Err("Invalid sign-in state".into());
    }
    let (listener, cancelled) = {
        let mut pending = state.0.lock().map_err(|e| e.to_string())?;
        let entry = pending
            .get_mut(&port)
            .ok_or("No sign-in is waiting on this port")?;
        (
            entry
                .listener
                .take()
                .ok_or("This sign-in is already waiting")?,
            entry.cancelled.clone(),
        )
    };
    open_in_browser(&url)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        serve(
            &listener,
            &expected_state,
            Instant::now() + WAIT,
            &cancelled,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(mut pending) = state.0.lock() {
        pending.remove(&port);
    }
    result
}

/// Stops waiting; the port closes.
#[tauri::command]
pub fn oidc_loopback_cancel(state: tauri::State<'_, OidcState>, port: u16) -> Result<(), String> {
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = pending.remove(&port) {
        entry.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // covers: proofs.oidc.callback.desktop
    use super::*;

    const STATE: &str = "d.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn request(port: u16, raw: String) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out);
        out
    }

    fn post(port: u16, host: &str, body: &str) -> String {
        request(
            port,
            format!(
                "POST /oidc-callback HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn hands_back_only_the_answer_for_the_awaited_state() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancelled = AtomicBool::new(false);
        let host = format!("127.0.0.1:{port}");
        let client = std::thread::spawn(move || {
            let page = request(
                port,
                format!("GET /oidc-callback HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            );
            assert!(page.starts_with("HTTP/1.1 200") && page.contains("fetch('/oidc-callback'"));
            assert!(
                request(port, format!("GET /other HTTP/1.1\r\nHost: {host}\r\n\r\n"))
                    .starts_with("HTTP/1.1 404")
            );
            // Another state, or a Host that is not this listener, is not the answer.
            assert!(post(port, &host, "#id_token=x&state=other").starts_with("HTTP/1.1 409"));
            assert!(
                post(port, "evil.example", &format!("#id_token=x&state={STATE}"))
                    .starts_with("HTTP/1.1 400")
            );
            assert!(post(port, &host, &format!("#id_token=abc&state={STATE}"))
                .starts_with("HTTP/1.1 200"));
        });
        let answer = serve(
            &listener,
            STATE,
            Instant::now() + Duration::from_secs(10),
            &cancelled,
        )
        .unwrap();
        client.join().unwrap();
        assert_eq!(answer, format!("#id_token=abc&state={STATE}"));
    }

    #[test]
    fn reads_the_state_from_the_query_for_code_answers() {
        assert_eq!(state_of("?code=c&state=s").as_deref(), Some("s"));
        assert_eq!(state_of("#state=f").as_deref(), Some("f"));
        assert_eq!(state_of("?x=1"), None);
    }

    #[test]
    fn stops_when_cancelled_or_timed_out() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let cancelled = AtomicBool::new(true);
        assert!(serve(
            &listener,
            STATE,
            Instant::now() + Duration::from_secs(10),
            &cancelled
        )
        .is_err());
        let cancelled = AtomicBool::new(false);
        assert!(serve(&listener, STATE, Instant::now(), &cancelled)
            .unwrap_err()
            .contains("timed out"));
    }

    #[test]
    fn opens_only_sign_in_addresses() {
        assert!(is_allowed_authorize_url(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=a&redirect_uri=b"
        ));
        assert!(!is_allowed_authorize_url(
            "https://accounts.google.com/o/oauth2/v2/auth"
        ));
        assert!(!is_allowed_authorize_url(
            "file:///etc/passwd?redirect_uri=b"
        ));
        assert!(!is_allowed_authorize_url(
            "https://user:pw@example.com/?redirect_uri=b"
        ));
        assert!(!is_allowed_authorize_url(
            "javascript:alert(1)//?redirect_uri=b"
        ));
    }
}

/// The commands around `serve`: where they listen, what they refuse before a
/// browser opens, and how a wait ends.
#[cfg(test)]
mod command_tests {
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::Manager;

    const STATE: &str = "d.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const AUTHORIZE: &str = "https://accounts.example/authorize?client_id=a&redirect_uri=b";

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(OidcState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn exchange(port: u16, raw: &[u8]) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let _ = stream.write_all(raw);
        let mut out = String::new();
        let _ = stream.read_to_string(&mut out);
        out
    }

    #[test]
    fn listens_on_loopback_for_one_sign_in_at_a_time() {
        let app = app();
        let first = oidc_loopback_start(app.state()).unwrap();
        let state = app.state::<OidcState>();
        let first_cancelled = {
            let pending = state.0.lock().unwrap();
            let entry = &pending[&first];
            let address = entry.listener.as_ref().unwrap().local_addr().unwrap();
            assert!(address.ip().is_loopback() && address.is_ipv4(), "{address}");
            assert_eq!(address.port(), first);
            entry.cancelled.clone()
        };

        let second = oidc_loopback_start(app.state()).unwrap();
        assert_ne!(first, second);
        assert!(
            first_cancelled.load(Ordering::SeqCst),
            "the abandoned one stops"
        );
        let pending = state.0.lock().unwrap();
        assert_eq!(pending.keys().copied().collect::<Vec<_>>(), [second]);
        drop(pending);
        // Its port closed with it.
        assert!(TcpStream::connect(("127.0.0.1", first)).is_err());
    }

    #[tokio::test]
    async fn refuses_before_any_browser_opens() {
        let app = app();
        let port = oidc_loopback_start(app.state()).unwrap();
        let wait = |url: &str, state: &str, port: u16| {
            oidc_loopback_wait(app.state(), port, url.into(), state.into())
        };
        for url in [
            "https://accounts.example/authorize?client_id=a",
            "https://accounts.example/authorize#redirect_uri=b",
            "http://accounts.example/authorize?redirect_uri=b",
            "file:///etc/passwd?redirect_uri=b",
            "ghostly://x?redirect_uri=b",
            "not a url",
        ] {
            assert_eq!(
                wait(url, STATE, port).await.unwrap_err(),
                "Not a sign-in address",
                "{url}"
            );
        }
        for state in ["", &STATE[..42], &"A".repeat(65)] {
            assert_eq!(
                wait(AUTHORIZE, state, port).await.unwrap_err(),
                "Invalid sign-in state"
            );
        }
        assert_eq!(
            wait(AUTHORIZE, STATE, port.wrapping_add(1))
                .await
                .unwrap_err(),
            "No sign-in is waiting on this port"
        );
        // One wait per listener: a second caller cannot take it over.
        app.state::<OidcState>()
            .0
            .lock()
            .unwrap()
            .get_mut(&port)
            .unwrap()
            .listener
            .take();
        assert_eq!(
            wait(AUTHORIZE, STATE, port).await.unwrap_err(),
            "This sign-in is already waiting"
        );
    }

    #[test]
    fn cancelling_ends_a_wait_in_progress_and_closes_the_port() {
        let app = app();
        let port = oidc_loopback_start(app.state()).unwrap();
        // What `oidc_loopback_wait` does once the browser is open.
        let state = app.state::<OidcState>();
        let (listener, cancelled) = {
            let mut pending = state.0.lock().unwrap();
            let entry = pending.get_mut(&port).unwrap();
            (entry.listener.take().unwrap(), entry.cancelled.clone())
        };
        let waiting = std::thread::spawn(move || {
            let result = serve(
                &listener,
                STATE,
                Instant::now() + Duration::from_secs(30),
                &cancelled,
            );
            drop(listener);
            result
        });
        std::thread::sleep(Duration::from_millis(100));
        oidc_loopback_cancel(app.state(), port).unwrap();
        assert_eq!(waiting.join().unwrap().unwrap_err(), "Sign-in cancelled");
        assert!(app.state::<OidcState>().0.lock().unwrap().is_empty());
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        // Cancelling what is not there is fine.
        oidc_loopback_cancel(app.state(), port).unwrap();
    }

    #[test]
    fn survives_junk_and_takes_exactly_one_answer() {
        let listener = crate::test_support::listener();
        let port = listener.local_addr().unwrap().port();
        let host = format!("127.0.0.1:{port}");
        let cancelled = AtomicBool::new(false);
        let client = std::thread::spawn(move || {
            // Too big, headers or body: the connection is dropped, the wait goes on.
            let huge = format!(
                "GET /oidc-callback HTTP/1.1\r\nHost: {host}\r\nX: {}\r\n\r\n",
                "a".repeat(MAX_REQUEST)
            );
            assert_eq!(exchange(port, huge.as_bytes()), "");
            let big_body = format!(
                "POST /oidc-callback HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n",
                MAX_REQUEST
            );
            assert_eq!(exchange(port, big_body.as_bytes()), "");
            // Not HTTP at all, or cut short.
            assert_eq!(exchange(port, b"\xff\xfe\r\n\r\n"), "");
            assert_eq!(exchange(port, b"POST /oidc-callback HTTP/1.1\r\n"), "");
            // No Host, or a name that only resolves here.
            for head in [
                "POST /oidc-callback HTTP/1.1\r\nContent-Length: 0\r\n\r\n".to_string(),
                format!("POST /oidc-callback HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Length: 0\r\n\r\n"),
            ] {
                assert!(exchange(port, head.as_bytes()).starts_with("HTTP/1.1 400"));
            }
            for (method, path) in [
                ("PUT", "/oidc-callback"),
                ("GET", "/"),
                ("POST", "/oidc-callback/x"),
            ] {
                let head = format!(
                    "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"
                );
                assert!(
                    exchange(port, head.as_bytes()).starts_with("HTTP/1.1 404"),
                    "{method} {path}"
                );
            }
            let page = exchange(
                port,
                format!("GET /oidc-callback?code=x HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes(),
            );
            for header in [
                "Cache-Control: no-store",
                "Referrer-Policy: no-referrer",
                "Content-Security-Policy: default-src 'none'",
                "connect-src 'self'",
            ] {
                assert!(page.contains(header), "{header}");
            }
            assert!(page.contains("history.replaceState"));
            let answer = format!("?code=c&state={STATE}");
            let post = format!(
                "POST /oidc-callback HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n{answer}",
                answer.len()
            );
            assert!(exchange(port, post.as_bytes()).starts_with("HTTP/1.1 200"));
        });
        let answer = serve(
            &listener,
            STATE,
            Instant::now() + Duration::from_secs(20),
            &cancelled,
        )
        .unwrap();
        client.join().unwrap();
        assert_eq!(answer, format!("?code=c&state={STATE}"));
        drop(listener);
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "one answer, then the port is gone"
        );
    }

    #[test]
    fn takes_the_state_from_the_fragment_before_the_query() {
        assert_eq!(
            state_of("?state=query#state=fragment").as_deref(),
            Some("fragment")
        );
        assert_eq!(state_of("#a=1&state=x%2By").as_deref(), Some("x+y"));
        assert_eq!(state_of(""), None);
    }

    #[test]
    fn a_loopback_provider_is_only_for_debug_builds() {
        let local = "http://127.0.0.1:47501/authorize?redirect_uri=b";
        assert_eq!(is_allowed_authorize_url(local), cfg!(debug_assertions));
        assert!(!is_allowed_authorize_url(
            "http://192.168.0.2/authorize?redirect_uri=b"
        ));
    }
}
