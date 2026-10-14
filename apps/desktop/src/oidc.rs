//! Signing in with an OpenID Connect provider from the desktop app.
//!
//! Providers block sign-in inside embedded WebViews, so the provider's page
//! opens in the system browser. It redirects to the web app's static callback
//! page, which forwards the answer (still in the fragment, never sent to a
//! server) to a listener here on 127.0.0.1. The listener accepts one answer
//! carrying the state the WebView expects, hands it back, and closes. It never
//! sees or keeps anything but that one redirect.
//!
//! Android has no listener: a phone's browser would leave the app in the
//! background, where Android may freeze it. The callback page hands the answer
//! to the app by a deep link instead (`ghostly://oidc?…#…`, the app's own
//! scheme), which brings it forward; the page asked with an `a.` state, and
//! only the answer for the awaited state is taken ([`OidcState::answer`]).

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const WAIT: Duration = Duration::from_secs(10 * 60);
const MAX_REQUEST: usize = 32 * 1024;
const PATH: &str = "/oidc-callback";
/// The "port" a deep-link sign-in reports to the page, which then asks with an [`APP_STATE`] state.
const DEEP_LINK: u16 = 0;
/// A deep-link sign-in's state starts with this (the page's `statePrefix`; the callback page reads it).
const APP_STATE: &str = "a.";
/// Where the callback page sends a deep-link sign-in's answer.
const DEEP_LINK_PREFIX: &str = "ghostly://oidc";

struct Pending {
    listener: Option<TcpListener>,
    cancelled: Arc<AtomicBool>,
    /// The app's language when the sign-in started, for the page the browser lands on.
    lang: String,
}

/// A deep-link sign-in waiting for its answer: the state it expects, and where the answer goes.
struct LinkWait {
    state: String,
    answer: oneshot::Sender<String>,
}

#[derive(Default)]
pub struct OidcState(Mutex<HashMap<u16, Pending>>, Mutex<Option<LinkWait>>);

impl OidcState {
    /// Waits for the deep link answering `state`. One sign-in at a time: one waiting before is dropped (its wait
    /// ends as cancelled).
    fn link_begin(&self, state: &str) -> oneshot::Receiver<String> {
        let (answer, waiting) = oneshot::channel();
        *self.1.lock().unwrap() = Some(LinkWait {
            state: state.to_string(),
            answer,
        });
        waiting
    }

    /// A deep link's answer ("?query#fragment"): handed to the sign-in waiting for its state, and true; any other
    /// (another state, none waiting, a second answer) is dropped, and false.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn answer(&self, answer: &str) -> bool {
        let mut waiting = self.1.lock().unwrap();
        let matches = waiting
            .as_ref()
            .is_some_and(|wait| state_of(answer).as_deref() == Some(wait.state.as_str()));
        if !matches {
            return false;
        }
        let wait = waiting.take().expect("checked above");
        wait.answer.send(answer.to_string()).is_ok()
    }

    /// Stops waiting for a deep link.
    fn link_cancel(&self) {
        self.1.lock().unwrap().take();
    }
}

/// The answer in a deep link (`ghostly://oidc?query#fragment`), as the loopback listener hands one back:
/// "?query#fragment". None for any other link, or one too long to be a sign-in's.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn deep_link_answer(link: &str) -> Option<String> {
    if link.len() > MAX_REQUEST {
        return None;
    }
    let rest = link.strip_prefix(DEEP_LINK_PREFIX)?;
    // Only the link itself: `ghostly://oidc?…`, `ghostly://oidc/?…` or `ghostly://oidc#…`, not `ghostly://oidcx`.
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    if !(rest.starts_with('?') || rest.starts_with('#')) {
        return None;
    }
    state_of(rest).map(|_| rest.to_string())
}

/// The page the browser lands on. The provider's answer is in its fragment,
/// which only a script can read; it posts it back to this same listener and
/// removes it from the browser's history entry.
///
/// It speaks the language the app named when the sign-in started (`lang`, a tag like "pt-BR"), English for any
/// other. The tag only chooses among the texts here; it is never written into the page.
fn page(lang: &str) -> String {
    let primary = lang
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (code, [returning, done, other, gone]) = TEXTS
        .iter()
        .find(|(code, _)| *code == primary)
        .unwrap_or(&TEXTS[0]);
    let dir = if *code == "ar" { "rtl" } else { "ltr" };
    let returning = returning.replace('&', "&amp;").replace('<', "&lt;");
    let (done, other, gone) = (quoted(done), quoted(other), quoted(gone));
    format!(
        "<!doctype html><html lang={code} dir={dir}><meta charset=utf-8><meta name=referrer content=no-referrer><title>Ghostly</title>\
<body style=\"font:16px system-ui;background:#050d14;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0\">\
<p id=m>{returning}</p><script>\
const a=location.search+location.hash;history.replaceState(null,'','/oidc-callback');\
fetch('/oidc-callback',{{method:'POST',body:a,headers:{{'content-type':'text/plain'}}}}).then(r=>{{\
document.getElementById('m').textContent=r.ok?{done}:{other}}})\
.catch(()=>{{document.getElementById('m').textContent={gone}}});\
</script>"
    )
}

/// What the page says, in the languages the app speaks (English first, the fallback): while the answer goes
/// back, once it is taken, when it is not the awaited one, and when nothing listens anymore.
const TEXTS: &[(&str, [&str; 4])] = &[
    (
        "en",
        [
            "Returning to Ghostly…",
            "Done. You can close this tab and return to Ghostly.",
            "This sign-in is no longer awaited. Return to Ghostly and try again.",
            "Ghostly is not waiting for this sign-in anymore.",
        ],
    ),
    (
        "ar",
        [
            "جارٍ العودة إلى Ghostly…",
            "تم. يمكنك إغلاق علامة التبويب هذه والعودة إلى Ghostly.",
            "تسجيل الدخول هذا لم يعد منتظرًا. عُد إلى Ghostly وحاول مرة أخرى.",
            "Ghostly لم يعد ينتظر تسجيل الدخول هذا.",
        ],
    ),
    (
        "es",
        [
            "Volviendo a Ghostly…",
            "Listo. Puedes cerrar esta pestaña y volver a Ghostly.",
            "Este inicio de sesión ya no se espera. Vuelve a Ghostly y vuelve a intentarlo.",
            "Ghostly ya no espera este inicio de sesión.",
        ],
    ),
    (
        "fr",
        [
            "Retour à Ghostly…",
            "Terminé. Vous pouvez fermer cet onglet et revenir à Ghostly.",
            "Cette connexion n'est plus attendue. Revenez à Ghostly, puis réessayez.",
            "Ghostly n'attend plus cette connexion.",
        ],
    ),
    (
        "it",
        [
            "Ritorno a Ghostly…",
            "Fatto. Puoi chiudere questa scheda e tornare a Ghostly.",
            "Questo accesso non è più atteso. Torna a Ghostly, poi riprova.",
            "Ghostly non attende più questo accesso.",
        ],
    ),
    (
        "ja",
        [
            "Ghostly に戻っています…",
            "完了しました。このタブを閉じて Ghostly に戻れます。",
            "このサインインはもう待たれていません。Ghostly に戻って、もう一度お試しください。",
            "Ghostly はもうこのサインインを待っていません。",
        ],
    ),
    (
        "pt",
        [
            "Voltando ao Ghostly…",
            "Pronto. Você pode fechar esta aba e voltar ao Ghostly.",
            "Este login não é mais aguardado. Volte ao Ghostly e tente de novo.",
            "O Ghostly não está mais aguardando este login.",
        ],
    ),
    (
        "zh",
        [
            "正在返回 Ghostly…",
            "完成。可以关闭此标签页并返回 Ghostly。",
            "此登录已不再等待。请返回 Ghostly，然后重试。",
            "Ghostly 已不再等待此登录。",
        ],
    ),
];

/// A text as a string of the page's script.
fn quoted(text: &str) -> String {
    format!(
        "'{}'",
        text.replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('<', "\\x3c")
    )
}

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

/// Serves the listener until an answer with `state` arrives, the wait ends, or it is cancelled. Its page is in
/// `lang`.
pub fn serve(
    listener: &TcpListener,
    state: &str,
    lang: &str,
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
            ("GET", PATH) => respond(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                &page(lang),
            ),
            ("POST", PATH) if state_of(&body).as_deref() == Some(state) => {
                respond(&mut stream, "200 OK", "text/plain", "OK");
                return Ok(body);
            }
            ("POST", PATH) => respond(&mut stream, "409 Conflict", "text/plain", "Not awaited"),
            _ => respond(&mut stream, "404 Not Found", "text/plain", "Not found"),
        }
    }
}

/// A provider's sign-in page: https, no credentials, and naming where it returns (`redirect_uri`), or,
/// for AT Protocol's pushed authorization requests, the request the server holds (`request_uri`).
#[cfg(test)]
fn is_allowed_authorize_url(url: &str) -> bool {
    authorize_url(url).is_some()
}

/// The sign-in page as it was checked: the parser drops spaces and control characters the text may carry, so the
/// browser is handed its normalized form, never the text as given.
fn authorize_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"));
    let allowed = parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed
            .query_pairs()
            .any(|(k, _)| k == "redirect_uri" || k == "request_uri")
        && (parsed.scheme() == "https"
            || (cfg!(debug_assertions) && parsed.scheme() == "http" && loopback));
    allowed.then(|| parsed.to_string())
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
    // Android: the browser Android has for the address. iOS: none yet.
    #[cfg(target_os = "android")]
    return crate::android::view(url);
    #[cfg(target_os = "ios")]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::other(format!(
        "No browser to open {} from here",
        url.split('?').next().unwrap_or_default()
    )));
    // The opener exits at once; waiting for it keeps no zombie behind until the app quits.
    #[cfg(not(target_os = "android"))]
    result
        .map(|mut child| drop(std::thread::spawn(move || child.wait())))
        .map_err(|e| e.to_string())
}

/// Listens on a free loopback port for one sign-in answer. Returns the port. Android and iOS listen for the app's
/// deep link instead, and say so with port 0 ([`DEEP_LINK`]): the page asks with an `a.` state then. `lang` is the
/// app's language, for the page the browser lands on ([`page`]).
#[tauri::command]
pub fn oidc_loopback_start(
    state: tauri::State<'_, OidcState>,
    lang: Option<String>,
) -> Result<u16, String> {
    if cfg!(mobile) {
        state.link_cancel();
        return Ok(DEEP_LINK);
    }
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
            lang: lang.unwrap_or_default(),
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
    let Some(url) = authorize_url(&url) else {
        return Err("Not a sign-in address".into());
    };
    // OpenID Connect states are 43+ characters; AT Protocol's OAuth client makes 22 (128 bits).
    if expected_state.len() < 22 || expected_state.len() > 64 {
        return Err("Invalid sign-in state".into());
    }
    if cfg!(mobile) && port == DEEP_LINK {
        return wait_for_link(&state, &url, &expected_state, open_in_browser).await;
    }
    let (listener, cancelled, lang) = {
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
            entry.lang.clone(),
        )
    };
    open_in_browser(&url)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        serve(
            &listener,
            &expected_state,
            &lang,
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

/// A deep-link sign-in (Android, iOS): the provider's page opens in the browser, and the wait ends with the answer
/// [`OidcState::answer`] takes for `expected` (an `a.` state), a cancel, or the time out.
async fn wait_for_link(
    state: &OidcState,
    url: &str,
    expected: &str,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    if !expected.starts_with(APP_STATE) {
        return Err("Invalid sign-in state".into());
    }
    let waiting = state.link_begin(expected);
    if let Err(error) = open(url) {
        state.link_cancel();
        return Err(error);
    }
    match tokio::time::timeout(WAIT, waiting).await {
        Ok(Ok(answer)) => Ok(answer),
        Ok(Err(_)) => Err("Sign-in cancelled".into()),
        Err(_) => {
            state.link_cancel();
            Err("Sign-in timed out. Try again.".into())
        }
    }
}

/// Stops waiting; the port closes (port 0: the deep link is no longer awaited).
#[tauri::command]
pub fn oidc_loopback_cancel(state: tauri::State<'_, OidcState>, port: u16) -> Result<(), String> {
    if cfg!(mobile) && port == DEEP_LINK {
        state.link_cancel();
        return Ok(());
    }
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
            "en",
            Instant::now() + Duration::from_secs(10),
            &cancelled,
        )
        .unwrap();
        client.join().unwrap();
        assert_eq!(answer, format!("#id_token=abc&state={STATE}"));
    }

    #[test]
    fn the_page_speaks_each_of_the_apps_languages() {
        let english = TEXTS[0].1;
        for lang in ["ar", "en", "es", "fr", "it", "ja", "pt", "zh"] {
            let page = page(lang);
            let texts = TEXTS
                .iter()
                .find(|(code, _)| *code == lang)
                .unwrap_or_else(|| panic!("no texts for {lang}"))
                .1;
            assert!(page.contains(&format!("<html lang={lang} ")), "{lang}");
            let dir = if lang == "ar" { "dir=rtl" } else { "dir=ltr" };
            assert!(page.contains(dir), "{lang}: {dir}");
            assert!(
                page.contains(&format!("<p id=m>{}</p>", texts[0])),
                "{lang}"
            );
            for (text, english) in texts.iter().zip(english).skip(1) {
                assert!(page.contains(&quoted(text)), "{lang}: {text}");
                if lang != "en" {
                    assert_ne!(*text, english, "{lang}");
                    assert!(!page.contains(english), "{lang}: {english}");
                }
            }
            // The script is the same in every language.
            assert!(
                page.contains("fetch('/oidc-callback'") && page.contains("history.replaceState")
            );
        }
        // An apostrophe in a text does not end the script's string.
        assert!(page("fr").contains("n\\'attend plus"));
    }

    #[test]
    fn the_page_takes_a_language_tag_and_falls_back_to_english() {
        assert_eq!(page("pt-BR"), page("pt"));
        assert_eq!(page("ZH_cn"), page("zh"));
        for lang in ["", "de", "x", "<script>", "en-US"] {
            assert_eq!(page(lang), page("en"), "{lang}");
        }
        assert!(page("en").contains("<p id=m>Returning to Ghostly…</p>"));
    }

    #[test]
    fn the_listener_serves_the_page_in_the_language_the_sign_in_started_in() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancelled = AtomicBool::new(false);
        let host = format!("127.0.0.1:{port}");
        let client = std::thread::spawn(move || {
            let answer = request(
                port,
                format!("GET /oidc-callback HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            );
            assert!(post(port, &host, &format!("#id_token=abc&state={STATE}"))
                .starts_with("HTTP/1.1 200"));
            answer
        });
        serve(
            &listener,
            STATE,
            "pt-BR",
            Instant::now() + Duration::from_secs(10),
            &cancelled,
        )
        .unwrap();
        let answer = client.join().unwrap();
        let body = answer.split_once("\r\n\r\n").unwrap().1;
        assert_eq!(body, page("pt"));
        assert!(answer.contains(&format!("Content-Length: {}\r\n", body.len())));
        assert!(!body.contains("Returning to Ghostly"));
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
            "en",
            Instant::now() + Duration::from_secs(10),
            &cancelled
        )
        .is_err());
        let cancelled = AtomicBool::new(false);
        assert!(serve(&listener, STATE, "en", Instant::now(), &cancelled)
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
        // AT Protocol: a pushed authorization request, held by the server.
        assert!(is_allowed_authorize_url(
            "https://bsky.social/oauth/authorize?client_id=a&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Areq-1"
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
        // The browser gets the address as checked, without the spaces and control characters the parser dropped.
        assert_eq!(
            authorize_url(" \u{1}https://accounts.example/au\tth?redirect_uri=b\n").as_deref(),
            Some("https://accounts.example/auth?redirect_uri=b")
        );
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
        let first = oidc_loopback_start(app.state(), None).unwrap();
        let state = app.state::<OidcState>();
        let first_cancelled = {
            let pending = state.0.lock().unwrap();
            let entry = &pending[&first];
            let address = entry.listener.as_ref().unwrap().local_addr().unwrap();
            assert!(address.ip().is_loopback() && address.is_ipv4(), "{address}");
            assert_eq!(address.port(), first);
            entry.cancelled.clone()
        };

        let second = oidc_loopback_start(app.state(), None).unwrap();
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
        let port = oidc_loopback_start(app.state(), None).unwrap();
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
        for state in ["", &STATE[..21], &"A".repeat(65)] {
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
        let port = oidc_loopback_start(app.state(), None).unwrap();
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
                "en",
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
            "en",
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

    const APP: &str = "a.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn a_deep_link_hands_back_its_query_and_fragment_and_nothing_else() {
        // covers: proofs.oidc.callback.android
        assert_eq!(
            deep_link_answer(&format!("ghostly://oidc?code=c&state={APP}")).as_deref(),
            Some(format!("?code=c&state={APP}").as_str())
        );
        assert_eq!(
            deep_link_answer(&format!("ghostly://oidc/#id_token=t&state={APP}")).as_deref(),
            Some(format!("#id_token=t&state={APP}").as_str())
        );
        assert_eq!(
            deep_link_answer(&format!("ghostly://oidc?x=1#id_token=t&state={APP}")).as_deref(),
            Some(format!("?x=1#id_token=t&state={APP}").as_str())
        );
        for link in [
            "ghostly://oidc".to_string(),
            "ghostly://oidc?code=c".to_string(),
            format!("ghostly://oidcx?state={APP}"),
            format!("ghostly://other?state={APP}"),
            format!("https://app.ghostly.tools/oidc?state={APP}"),
            format!("ghostly://oidc/more?state={APP}"),
            format!("ghostly://oidc?state={APP}&pad={}", "a".repeat(MAX_REQUEST)),
        ] {
            assert_eq!(deep_link_answer(&link), None, "{link}");
        }
    }

    #[tokio::test]
    async fn a_deep_link_sign_in_takes_only_the_answer_for_its_state() {
        // covers: proofs.oidc.callback.android
        let state = Arc::new(OidcState::default());
        // Nobody waits yet: an answer goes nowhere.
        assert!(!state.answer(&format!("?code=c&state={APP}")));
        let opened = Arc::new(Mutex::new(None));
        let waiting = {
            let (state, opened) = (state.clone(), opened.clone());
            tokio::spawn(async move {
                wait_for_link(&state, AUTHORIZE, APP, |url| {
                    *opened.lock().unwrap() = Some(url.to_string());
                    Ok(())
                })
                .await
            })
        };
        while opened.lock().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(opened.lock().unwrap().as_deref(), Some(AUTHORIZE));
        assert!(!state.answer("?code=c&state=a.other"), "another state");
        assert!(!state.answer("?code=c"), "no state");
        assert!(state.answer(&format!("?code=c&state={APP}")));
        assert!(
            !state.answer(&format!("?code=again&state={APP}")),
            "taken once"
        );
        assert_eq!(
            waiting.await.unwrap().unwrap(),
            format!("?code=c&state={APP}")
        );
    }

    #[tokio::test]
    async fn a_deep_link_sign_in_ends_when_cancelled_refused_or_replaced() {
        // covers: proofs.oidc.callback.android
        let state = Arc::new(OidcState::default());
        // A loopback state is not a deep link's: refused before any browser opens.
        let refused = wait_for_link(&state, AUTHORIZE, STATE, |_| panic!("no browser")).await;
        assert_eq!(refused.unwrap_err(), "Invalid sign-in state");
        // The browser could not be opened: nothing is left waiting.
        let failed = wait_for_link(&state, AUTHORIZE, APP, |_| Err("No app".into())).await;
        assert_eq!(failed.unwrap_err(), "No app");
        assert!(!state.answer(&format!("?code=c&state={APP}")));
        // Cancelled (the page's cancel, or a new sign-in starting), the wait ends.
        let waiting = {
            let state = state.clone();
            tokio::spawn(async move { wait_for_link(&state, AUTHORIZE, APP, |_| Ok(())).await })
        };
        while state.1.lock().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        state.link_cancel();
        assert_eq!(waiting.await.unwrap().unwrap_err(), "Sign-in cancelled");
        assert!(!state.answer(&format!("?code=c&state={APP}")));
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
