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

/// Only this machine, never a redirect, never more than the limit.
#[cfg(test)]
mod tests {
    // covers: desktop.local-fetch
    use super::*;
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
