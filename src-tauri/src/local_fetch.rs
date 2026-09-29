//! Requests to a web app the user shares from this machine.
//!
//! They go through Rust, not the WebView's `fetch`: CORS would stop most of
//! them, and this is where the list of allowed addresses is kept. (The CSP lets
//! the WebView reach loopback for the local test servers the wallets and backups
//! accept, so it is not what keeps a contact's requests off other ports: the
//! list below is.) Which service maps to which address is decided by the peer; this side
//! refuses anything that is not loopback and never follows a redirect, so a
//! request can only ever reach this machine, and only an address the person
//! allowed in a native dialog (`local_access`), so not every port on it.

use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::future::Future;

use crate::local_access::{origin_of, LocalAccess, Reason};

const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
pub struct LocalResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_b64: String,
}

pub fn is_loopback(url: &reqwest::Url) -> bool {
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
        // Straight to this machine: a proxy set on the system would be handed every request to
        // the shared app, and where it sends them is its own business.
        .no_proxy()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// `fetch`, for an address on the profile's list of shared apps only. One that is not on it (an
/// app shared before the list existed) is asked about once (`ask`, the native dialog); a refused
/// or unasked one is never connected to.
pub async fn fetch_shared<F, Fut>(
    access: &LocalAccess,
    space: &str,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
    ask: F,
) -> Result<LocalResponse, String>
where
    F: FnOnce(String, Reason) -> Fut,
    Fut: Future<Output = bool>,
{
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let origin = origin_of(&parsed)?;
    access.ensure(space, &origin, Reason::FirstUse, ask).await?;
    fetch(url, method, headers, body_b64).await
}

pub async fn fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
) -> Result<LocalResponse, String> {
    let url = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !matches!(url.scheme(), "http" | "https") || !is_loopback(&url) {
        return Err(crate::local_access::NOT_LOCAL.into());
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

/// Only this machine, never a redirect, never more than the limit.
#[cfg(test)]
mod tests {
    // covers: desktop.local-fetch
    use super::*;
    use crate::local_access::NOT_LOCAL;
    use crate::test_support::{closed_port, read_request, respond, tokio_listener, Requests};
    use tokio::io::AsyncWriteExt;

    /// A server answering every request with `reply`; returns its address and the requests it saw.
    fn server(reply: Vec<u8>) -> (String, Requests) {
        let listener = tokio_listener();
        let address = listener.local_addr().unwrap();
        let seen = Requests::default();
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                if let Some(request) = read_request(&mut stream).await {
                    log.lock().unwrap().push(request);
                }
                let _ = stream.write_all(&reply).await;
                let _ = stream.shutdown().await;
            }
        });
        (format!("http://{address}"), seen)
    }

    fn no_ask(_: String, _: Reason) -> std::future::Ready<bool> {
        panic!("nobody may be asked here")
    }

    async fn shared(
        access: &LocalAccess,
        url: &str,
        answer: bool,
    ) -> Result<LocalResponse, String> {
        fetch_shared(
            access,
            "ghostly_a",
            url.into(),
            "GET".into(),
            vec![],
            None,
            |_, _| std::future::ready(answer),
        )
        .await
    }

    #[tokio::test]
    async fn a_port_nobody_allowed_is_never_connected_to() {
        let (url, seen) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        let access = LocalAccess::default();
        let error = shared(&access, &format!("{url}/secret"), false)
            .await
            .unwrap_err();
        assert!(error.contains("is not an app you allowed"), "{error}");
        // Refused once: a contact's next request is not asked about again, nor let through.
        let error = fetch_shared(
            &access,
            "ghostly_a",
            format!("{url}/secret"),
            "GET".into(),
            vec![],
            None,
            no_ask,
        )
        .await
        .unwrap_err();
        assert!(error.contains("is not an app you allowed"), "{error}");
        assert!(seen.lock().unwrap().is_empty());

        // Not this machine: refused before anyone is asked.
        for url in [
            "http://example.com/",
            "http://10.0.0.1:3400/",
            "file:///etc/passwd",
        ] {
            let error = fetch_shared(
                &access,
                "ghostly_a",
                url.into(),
                "GET".into(),
                vec![],
                None,
                no_ask,
            )
            .await
            .unwrap_err();
            assert_eq!(error, NOT_LOCAL, "{url}");
        }
    }

    #[tokio::test]
    async fn an_allowed_port_is_reached_and_its_neighbours_are_not() {
        let (allowed, reached) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec());
        let (other, other_seen) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        let access = LocalAccess::default();
        let origin = origin_of(&reqwest::Url::parse(&allowed).unwrap()).unwrap();
        access
            .ensure("ghostly_a", &origin, Reason::Share, |_, _| async { true })
            .await
            .unwrap();

        let answer = fetch_shared(
            &access,
            "ghostly_a",
            format!("{allowed}/api"),
            "GET".into(),
            vec![],
            None,
            no_ask,
        )
        .await
        .unwrap();
        assert_eq!(STANDARD.decode(answer.body_b64).unwrap(), b"ok");
        assert_eq!(reached.lock().unwrap().len(), 1);

        // Same machine, another port; the same port in another profile.
        assert!(shared(&access, &other, false).await.is_err());
        assert!(other_seen.lock().unwrap().is_empty());
        let error = fetch_shared(
            &access,
            "ghostly_b",
            allowed.clone(),
            "GET".into(),
            vec![],
            None,
            |_, _| std::future::ready(false),
        )
        .await
        .unwrap_err();
        assert!(error.contains("is not an app you allowed"), "{error}");
        assert_eq!(reached.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_app_shared_before_the_list_is_asked_about_once_then_reached() {
        let (url, seen) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        let access = LocalAccess::default();
        let asked = std::sync::Mutex::new(Vec::new());
        for _ in 0..2 {
            fetch_shared(
                &access,
                "ghostly_a",
                url.clone(),
                "GET".into(),
                vec![],
                None,
                |origin, reason| {
                    asked.lock().unwrap().push((origin, reason));
                    std::future::ready(true)
                },
            )
            .await
            .unwrap();
        }
        let origin = origin_of(&reqwest::Url::parse(&url).unwrap()).unwrap();
        assert_eq!(*asked.lock().unwrap(), vec![(origin, Reason::FirstUse)]);
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_allowed_app_cannot_redirect_a_request_to_another_port() {
        let (target, reached) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        let (url, _) = server(
            format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}/secret\r\nContent-Length: 0\r\n\r\n")
                .into_bytes(),
        );
        let access = LocalAccess::default();
        let answer = shared(&access, &url, true).await.unwrap();
        assert_eq!(answer.status, 307);
        assert!(reached.lock().unwrap().is_empty());
        let target_origin = origin_of(&reqwest::Url::parse(&target).unwrap()).unwrap();
        assert!(!access.is_allowed("ghostly_a", &target_origin));
    }

    #[tokio::test]
    async fn refuses_every_host_that_is_not_this_machine_before_connecting() {
        for url in [
            "http://example.com/",
            "https://10.0.0.1/",
            "http://192.168.1.1:8080/",
            "http://0.0.0.0:47500/",
            "http://[::ffff:127.0.0.1]:47500/",
            "http://localhost.evil.example/",
            "http://127.0.0.1.nip.io/",
            "http://evil.example#@127.0.0.1/",
            "ftp://127.0.0.1/",
            "file:///etc/passwd",
            "ws://127.0.0.1/",
            "not a url",
        ] {
            let error = fetch(url.into(), "GET".into(), vec![], None)
                .await
                .unwrap_err();
            assert!(
                error == "Only services on this machine can be shared"
                    || error.starts_with("Invalid URL"),
                "{url}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn forwards_method_path_headers_and_body_and_returns_the_answer() {
        let (url, seen) = server(
            b"HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nX-Two: a\r\nContent-Length: 5\r\n\r\nhello".to_vec(),
        );
        let answer = fetch(
            format!("{url}/api/items?limit=5"),
            "PATCH".into(),
            vec![("X-Ghostly".into(), "1".into())],
            Some(STANDARD.encode(b"{\"a\":1}")),
        )
        .await
        .unwrap();
        assert_eq!(answer.status, 201);
        assert!(answer
            .headers
            .contains(&("content-type".into(), "text/plain".into())));
        assert_eq!(STANDARD.decode(answer.body_b64).unwrap(), b"hello");

        let (head, body) = seen.lock().unwrap()[0].clone();
        assert!(
            head.starts_with("PATCH /api/items?limit=5 HTTP/1.1"),
            "{head}"
        );
        assert!(head.to_ascii_lowercase().contains("x-ghostly: 1"));
        assert_eq!(body, b"{\"a\":1}");

        // `localhost` by name is this machine too.
        let port = url.rsplit(':').next().unwrap();
        for host in ["localhost", "127.0.0.1"] {
            assert_eq!(
                fetch(format!("http://{host}:{port}/"), "GET".into(), vec![], None)
                    .await
                    .unwrap()
                    .status,
                201
            );
        }
    }

    #[tokio::test]
    async fn never_follows_a_redirect_even_to_this_machine() {
        let (target, reached) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        let (url, _) = server(
            format!("HTTP/1.1 302 Found\r\nLocation: {target}/secret\r\nContent-Length: 0\r\n\r\n")
                .into_bytes(),
        );
        let answer = fetch(url, "GET".into(), vec![], None).await.unwrap();
        assert_eq!(answer.status, 302);
        assert!(answer
            .headers
            .iter()
            .any(|(name, value)| name == "location" && value.ends_with("/secret")));
        assert!(reached.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_a_bad_method_or_body_and_reports_an_unreachable_service() {
        let (url, seen) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec());
        assert_eq!(
            fetch(url.clone(), "GE T".into(), vec![], None)
                .await
                .unwrap_err(),
            "Invalid method"
        );
        assert!(
            fetch(url, "POST".into(), vec![], Some("not base64!".into()))
                .await
                .unwrap_err()
                .starts_with("Body:")
        );
        assert!(seen.lock().unwrap().is_empty());

        let error = fetch(
            format!("http://127.0.0.1:{}/", closed_port()),
            "GET".into(),
            vec![],
            None,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("unreachable:"), "{error}");
    }

    #[tokio::test]
    async fn stops_reading_past_the_response_limit() {
        let listener = tokio_listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            // No Content-Length: the size is only known by reading.
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await;
            let chunk = vec![b'x'; 1 << 20];
            for _ in 0..=MAX_RESPONSE_BYTES >> 20 {
                let head = format!("{:x}\r\n", chunk.len());
                if stream.write_all(head.as_bytes()).await.is_err()
                    || stream.write_all(&chunk).await.is_err()
                    || stream.write_all(b"\r\n").await.is_err()
                {
                    return;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
        });
        assert_eq!(
            fetch(url, "GET".into(), vec![], None).await.unwrap_err(),
            "Response too large"
        );
    }

    /// A proxy set in the environment is never handed a shared app's requests: they go straight
    /// to this machine. The client reads the proxy settings once per process, so the request is
    /// made in a child run of this test binary (`requests_skip_the_proxy`), with a proxy set that
    /// answers 502 to anything it is given.
    #[test]
    fn a_proxy_in_the_environment_is_never_used() {
        let proxy = crate::test_support::listener();
        let address = format!("http://{}", proxy.local_addr().unwrap());
        let used = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = used.clone();
        std::thread::spawn(move || {
            for stream in proxy.incoming() {
                let Ok(mut stream) = stream else { return };
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child.args([
            "--ignored",
            "--exact",
            "local_fetch::tests::requests_skip_the_proxy",
            "--test-threads=1",
        ]);
        for name in ["NO_PROXY", "no_proxy"] {
            child.env_remove(name);
        }
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            child.env(name, &address);
        }
        let output = child.output().unwrap();
        let log = String::from_utf8_lossy(&output.stdout);
        assert!(
            log.contains("1 passed"),
            "the child run did not pass:\n{log}"
        );
        assert_eq!(used.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    #[ignore = "run by a_proxy_in_the_environment_is_never_used, with a proxy set"]
    async fn requests_skip_the_proxy() {
        let (url, seen) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec());
        let answer = fetch(format!("{url}/api"), "GET".into(), vec![], None)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_large_answer_comes_back_whole() {
        let listener = tokio_listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            respond(&mut stream, "200 OK", &[], &vec![b'y'; 1 << 20]).await;
        });
        let answer = fetch(url, "GET".into(), vec![], None).await.unwrap();
        assert_eq!(STANDARD.decode(answer.body_b64).unwrap().len(), 1 << 20);
    }
}
