//! Requests to the person's LND node, for the LND Lightning source
//! (packages/browser/src/engine/paymentAdapters/providers/lnd.ts).
//!
//! A WebView reaches a node's REST API only when the node allows its origin
//! (CORS) and presents a certificate the WebView trusts, and LND's own is
//! self-signed. From here neither is needed. When the person gives the node's
//! certificate it is pinned: the node must present exactly that certificate,
//! whatever name or address it is reached by (an IP or a .onion is rarely in
//! it). Without one, the usual public authorities decide.
//!
//! Only LND's REST paths are reachable, redirects are never followed, answers
//! are bounded in size and time, and the macaroon goes nowhere but the header.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use tokio::time::Instant;

const MAX_BODY: usize = 1 << 20;
const MAX_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_MACAROON_HEX: usize = 16 * 1024;
const CLIENTS: usize = 4;

#[derive(Debug, Serialize, PartialEq)]
pub struct LndResponse {
    pub status: u16,
    /// A unary answer is one line; a stream is its messages, one per line.
    pub lines: Vec<String>,
    /// A stream was still open at the deadline; `lines` is what it said so far.
    pub timed_out: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stream {
    /// Stop at the first message (TrackPaymentV2: where a payment stands now).
    First,
    /// Stop at a payment's last update (SUCCEEDED, FAILED) or an error.
    Final,
}

pub struct LndRequest {
    pub url: String,
    pub macaroon: String,
    /// The node's certificate, base64 DER, to pin.
    pub certificate: Option<String>,
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    pub stream: Option<String>,
    pub timeout_ms: u64,
}

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// The node's address: https, or http on this machine; nothing but scheme, host and port.
fn node_url(url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid node address".to_string())?;
    let secure = url.scheme() == "https" || (url.scheme() == "http" && is_loopback(&url));
    if !secure || url.host().is_none() {
        return Err("The node address must be https (http only on this machine)".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The node address must be only scheme, host and port".into());
    }
    Ok(url)
}

/// Only LND's REST API: `/v1/…` or `/v2/…`, with the characters its paths and queries use. The one
/// escape is `%3D`, the padding of base64 in a path: no other, so nothing decodes into `..` or `/`.
fn api_path(path: &str) -> Result<&str, String> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "/_-=?&.%".contains(c);
    let escapes = path
        .match_indices('%')
        .all(|(i, _)| path[i..].starts_with("%3D"));
    if !(path.starts_with("/v1/") || path.starts_with("/v2/"))
        || !escapes
        || path.contains("..")
        || path.contains("//")
        || path.len() > 512
        || !path.chars().all(allowed)
    {
        return Err("Not an LND REST path".into());
    }
    Ok(path)
}

/// A payment update after which nothing changes, or an error: the end of a `Final` stream.
pub fn is_final(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return true;
    };
    value.get("error").is_some()
        || matches!(
            value.pointer("/result/status").and_then(|s| s.as_str()),
            Some("SUCCEEDED" | "FAILED")
        )
}

/// Accepts the one certificate it was given, and still checks the handshake is signed by its key.
#[derive(Debug)]
struct Pinned {
    certificate: CertificateDer<'static>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.certificate.as_ref() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the node presented another certificate than the one pinned".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn build_client(certificate: Option<&[u8]>) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(60));
    let builder = match certificate {
        Some(der) => {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let verifier = Pinned {
                certificate: CertificateDer::from(der.to_vec()),
                provider: provider.clone(),
            };
            let config = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| format!("TLS: {}", e))?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth();
            builder.tls_backend_preconfigured(config)
        }
        None => builder,
    };
    builder.build().map_err(|e| format!("HTTP client: {}", e))
}

/// A few clients, one per certificate, so polling a node reuses its connection.
fn client(certificate: Option<Vec<u8>>) -> Result<reqwest::Client, String> {
    static CACHE: Mutex<Vec<(Option<Vec<u8>>, reqwest::Client)>> = Mutex::new(Vec::new());
    let mut cache = CACHE
        .lock()
        .map_err(|_| "HTTP client cache poisoned".to_string())?;
    if let Some((_, client)) = cache.iter().find(|(key, _)| *key == certificate) {
        return Ok(client.clone());
    }
    let client = build_client(certificate.as_deref())?;
    if cache.len() >= CLIENTS {
        cache.remove(0);
    }
    cache.push((certificate, client.clone()));
    Ok(client)
}

pub async fn request(request: LndRequest) -> Result<LndResponse, String> {
    let url = node_url(&request.url)?
        .join(api_path(&request.path)?)
        .map_err(|_| "Not an LND REST path".to_string())?;
    let macaroon = request.macaroon.trim();
    if macaroon.is_empty()
        || macaroon.len() > MAX_MACAROON_HEX
        || !macaroon.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("The macaroon must be hex".into());
    }
    let stream = match request.stream.as_deref() {
        None => None,
        Some("first") => Some(Stream::First),
        Some("final") => Some(Stream::Final),
        Some(_) => return Err("Unknown stream mode".into()),
    };
    let certificate = match request
        .certificate
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        Some(b64) => Some(
            STANDARD
                .decode(b64)
                .map_err(|_| "The certificate must be base64 DER".to_string())?,
        ),
        None => None,
    };
    let client = client(certificate)?;
    let mut builder = match request.method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        _ => return Err("Unsupported method".into()),
    }
    .header("Grpc-Metadata-macaroon", macaroon);
    if let Some(body) = request.body {
        if body.len() > MAX_BODY {
            return Err("Request too large".into());
        }
        builder = builder
            .header("Content-Type", "application/json")
            .body(body);
    }
    let timeout = Duration::from_millis(request.timeout_ms.max(1)).min(MAX_TIMEOUT);
    let deadline = Instant::now() + timeout;
    // Never the URL or the macaroon in an error: only what went wrong.
    let response = match tokio::time::timeout_at(deadline, builder.send()).await {
        Err(_) => return Err("The node did not answer in time".into()),
        Ok(Err(error)) => return Err(format!("Could not reach the node: {}", describe(&error))),
        Ok(Ok(response)) => response,
    };
    read(response, stream, deadline).await
}

/// The innermost cause: reqwest's own message carries the URL, the cause says what went wrong.
fn describe(error: &reqwest::Error) -> String {
    let mut source: Option<&dyn std::error::Error> = Some(error);
    let mut last = String::from("connection failed");
    while let Some(e) = source {
        last = e.to_string();
        source = e.source();
    }
    last.chars().take(200).collect()
}

async fn read(
    mut response: reqwest::Response,
    stream: Option<Stream>,
    deadline: Instant,
) -> Result<LndResponse, String> {
    let status = response.status().as_u16();
    let mut lines = Vec::new();
    let mut buffer: Vec<u8> = Vec::new();
    let mut total = 0usize;
    loop {
        let chunk = match tokio::time::timeout_at(deadline, response.chunk()).await {
            Err(_) if stream.is_some() => {
                return Ok(LndResponse {
                    status,
                    lines,
                    timed_out: true,
                });
            }
            Err(_) => return Err("The node did not answer in time".into()),
            Ok(Err(error)) => {
                return Err(format!("The node's answer broke off: {}", describe(&error)))
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => chunk,
        };
        total += chunk.len();
        if total > MAX_BODY {
            return Err("The node's answer is too large".into());
        }
        buffer.extend_from_slice(&chunk);
        let Some(mode) = stream else { continue };
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line).trim().to_string();
            if line.is_empty() {
                continue;
            }
            let done = mode == Stream::First || is_final(&line);
            lines.push(line);
            if done {
                return Ok(LndResponse {
                    status,
                    lines,
                    timed_out: false,
                });
            }
        }
    }
    let rest = String::from_utf8_lossy(&buffer).trim().to_string();
    if !rest.is_empty() {
        lines.push(rest);
    }
    Ok(LndResponse {
        status,
        lines,
        timed_out: false,
    })
}

#[cfg(test)]
mod tests {
    // covers: wallet.lightning.lnd.connect, wallet.lightning.lnd.pay
    // covers-gated: wallet.lightning.lnd.connect
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;

    /// A self-signed certificate for a name that is not the one it is reached by: pinning ignores names.
    fn certificate() -> (Vec<u8>, rustls::pki_types::PrivateKeyDer<'static>) {
        let cert =
            rcgen::generate_simple_self_signed(vec!["not-this-host.example".into()]).unwrap();
        (
            cert.cert.der().to_vec(),
            rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into()),
        )
    }

    #[derive(Clone)]
    enum Answer {
        /// One JSON body.
        Unary(&'static str),
        /// Chunked lines, then the connection stays open (a payment still in flight).
        Stream(Vec<&'static str>),
        /// Accepts, never answers.
        Silent,
        Redirect,
    }

    /// An HTTPS server on 127.0.0.1 with that certificate. Returns its address and each request's head.
    async fn node(
        der: Vec<u8>,
        key: rustls::pki_types::PrivateKeyDer<'static>,
        answer: Answer,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![CertificateDer::from(der)], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!(
            "https://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        );
        let heads = Arc::new(Mutex::new(Vec::new()));
        let seen = heads.clone();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let (acceptor, answer, seen) = (acceptor.clone(), answer.clone(), seen.clone());
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(socket).await else {
                        return;
                    };
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n")
                        && tls.read(&mut byte).await.unwrap_or(0) == 1
                    {
                        head.push(byte[0]);
                    }
                    seen.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&head).to_string());
                    match answer {
                        Answer::Unary(body) => {
                            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
                            let _ = tls.write_all(response.as_bytes()).await;
                        }
                        Answer::Stream(lines) => {
                            let _ = tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n").await;
                            for line in lines {
                                let chunk = format!("{}\n", line);
                                let _ = tls
                                    .write_all(
                                        format!("{:x}\r\n{}\r\n", chunk.len(), chunk).as_bytes(),
                                    )
                                    .await;
                                let _ = tls.flush().await;
                            }
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                        Answer::Silent => tokio::time::sleep(Duration::from_secs(30)).await,
                        Answer::Redirect => {
                            let _ = tls.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.com/\r\nContent-Length: 0\r\n\r\n").await;
                        }
                    }
                });
            }
        });
        (address, heads)
    }

    fn call(
        url: &str,
        certificate: Option<&[u8]>,
        path: &str,
        stream: Option<&str>,
        timeout_ms: u64,
    ) -> LndRequest {
        LndRequest {
            url: url.into(),
            macaroon: "0201036c6e64".into(),
            certificate: certificate.map(|c| STANDARD.encode(c)),
            method: "GET".into(),
            path: path.into(),
            body: None,
            stream: stream.map(Into::into),
            timeout_ms,
        }
    }

    #[test]
    fn only_lnd_rest_paths_on_a_bare_https_address() {
        assert!(api_path("/v1/getinfo").is_ok());
        assert!(api_path("/v2/router/track/abc-_%3D?no_inflight_updates=false").is_ok());
        for bad in [
            "/v3/x",
            "v1/getinfo",
            "/v1/../admin",
            "/v1//x",
            "/v1/x#y",
            "/v1/x y",
            "/v1/%2e%2e",
            "/v1/%2F",
            "/v1/x%3",
        ] {
            assert!(api_path(bad).is_err(), "{bad}");
        }
        assert!(node_url("https://node.example:8080").is_ok());
        assert!(node_url("http://127.0.0.1:8080").is_ok());
        for bad in [
            "http://node.example:8080",
            "https://user:pw@node.example",
            "https://node.example/v1",
            "https://node.example?x=1",
            "ftp://node.example",
            "nonsense",
        ] {
            assert!(node_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_payment_stream_ends_at_its_last_update_or_an_error() {
        assert!(!is_final(r#"{"result":{"status":"IN_FLIGHT"}}"#));
        assert!(!is_final(r#"{"result":{"status":"INITIATED"}}"#));
        assert!(is_final(r#"{"result":{"status":"SUCCEEDED"}}"#));
        assert!(is_final(
            r#"{"result":{"status":"FAILED","failure_reason":"FAILURE_REASON_NO_ROUTE"}}"#
        ));
        assert!(is_final(
            r#"{"error":{"code":2,"message":"invoice expired"}}"#
        ));
        assert!(is_final("not json"));
    }

    #[tokio::test]
    async fn the_pinned_certificate_is_accepted_whatever_the_name_and_another_is_refused() {
        let (der, key) = certificate();
        let (url, heads) = node(der.clone(), key, Answer::Unary(r#"{"alias":"pinned"}"#)).await;
        let answer = request(call(&url, Some(&der), "/v1/getinfo", None, 5_000))
            .await
            .unwrap();
        assert_eq!(
            answer,
            LndResponse {
                status: 200,
                lines: vec![r#"{"alias":"pinned"}"#.into()],
                timed_out: false
            }
        );
        let head = heads.lock().unwrap()[0].to_lowercase();
        assert!(head.starts_with("get /v1/getinfo http/1.1"));
        assert!(head.contains("grpc-metadata-macaroon: 0201036c6e64"));

        let (other, _) = certificate();
        let error = request(call(&url, Some(&other), "/v1/getinfo", None, 5_000))
            .await
            .unwrap_err();
        assert!(error.contains("certificate"), "{error}");
        // Without a pin, a self-signed certificate is not trusted.
        assert!(request(call(&url, None, "/v1/getinfo", None, 5_000))
            .await
            .is_err());
        assert_eq!(
            heads.lock().unwrap().len(),
            1,
            "no request went out over an unverified connection"
        );
    }

    #[tokio::test]
    async fn a_stream_stops_at_the_final_update_or_reports_what_it_saw_at_the_deadline() {
        let (der, key) = certificate();
        let (url, _) = node(
            der.clone(),
            key.clone_key(),
            Answer::Stream(vec![
                r#"{"result":{"status":"IN_FLIGHT"}}"#,
                r#"{"result":{"status":"SUCCEEDED","fee_sat":"1"}}"#,
            ]),
        )
        .await;
        let started = Instant::now();
        let answer = request(call(
            &url,
            Some(&der),
            "/v2/router/send",
            Some("final"),
            10_000,
        ))
        .await
        .unwrap();
        assert_eq!(answer.lines.len(), 2);
        assert!(!answer.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "it did not wait for the connection to close"
        );

        let (url, _) = node(
            der.clone(),
            key.clone_key(),
            Answer::Stream(vec![r#"{"result":{"status":"IN_FLIGHT"}}"#]),
        )
        .await;
        let answer = request(call(
            &url,
            Some(&der),
            "/v2/router/send",
            Some("final"),
            700,
        ))
        .await
        .unwrap();
        assert_eq!(
            answer,
            LndResponse {
                status: 200,
                lines: vec![r#"{"result":{"status":"IN_FLIGHT"}}"#.into()],
                timed_out: true
            }
        );
        let answer = request(call(
            &url,
            Some(&der),
            "/v2/router/track/x",
            Some("first"),
            10_000,
        ))
        .await
        .unwrap();
        assert_eq!((answer.lines.len(), answer.timed_out), (1, false));
    }

    #[tokio::test]
    async fn silence_is_an_error_and_redirects_are_not_followed() {
        let (der, key) = certificate();
        let (url, _) = node(der.clone(), key.clone_key(), Answer::Silent).await;
        let error = request(call(&url, Some(&der), "/v1/getinfo", None, 500))
            .await
            .unwrap_err();
        assert!(error.contains("did not answer"), "{error}");
        // Even a stream: nothing was said, so nothing is known.
        assert!(request(call(
            &url,
            Some(&der),
            "/v2/router/send",
            Some("final"),
            500
        ))
        .await
        .is_err());

        let (url, _) = node(der.clone(), key, Answer::Redirect).await;
        assert_eq!(
            request(call(&url, Some(&der), "/v1/getinfo", None, 5_000))
                .await
                .unwrap()
                .status,
            302
        );
    }

    #[tokio::test]
    async fn bad_input_never_reaches_the_network() {
        let mut bad = call("https://127.0.0.1:1", None, "/v1/getinfo", None, 1_000);
        bad.macaroon = "not hex".into();
        assert_eq!(request(bad).await.unwrap_err(), "The macaroon must be hex");
        let mut bad = call("https://127.0.0.1:1", None, "/v1/getinfo", None, 1_000);
        bad.method = "DELETE".into();
        assert_eq!(request(bad).await.unwrap_err(), "Unsupported method");
        let bad = call(
            "https://127.0.0.1:1",
            None,
            "/v1/getinfo",
            Some("all"),
            1_000,
        );
        assert_eq!(request(bad).await.unwrap_err(), "Unknown stream mode");
    }

    /// Against the regtest stack of e2e/support/lnd-regtest (GHOSTLY_LND_REGTEST=1): Alice's node, its own
    /// self-signed certificate pinned, reached at 127.0.0.1. Nothing is printed.
    #[tokio::test]
    async fn a_regtest_node_answers_through_its_pinned_certificate() {
        if std::env::var("GHOSTLY_LND_REGTEST").as_deref() != Ok("1") {
            return;
        }
        let exec = |args: &[&str]| {
            let out = std::process::Command::new("docker")
                .args(["exec", "ghostly-lnd-alice"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        let macaroon = exec(&["cat", "/root/.lnd/ghostly-scoped.macaroon.hex"]);
        let pem = exec(&["cat", "/root/.lnd/tls.cert"]);
        let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        let mut info = call("https://127.0.0.1:44710", None, "/v1/getinfo", None, 10_000);
        info.macaroon = macaroon.clone();
        info.certificate = Some(b64.clone());
        let answer = request(info).await.unwrap();
        assert_eq!(answer.status, 200);
        let value: serde_json::Value = serde_json::from_str(&answer.lines[0]).unwrap();
        assert_eq!(
            value.pointer("/chains/0/network").and_then(|n| n.as_str()),
            Some("regtest")
        );

        // TrackPaymentV2 reads the escaped base64 of a hash: a payment it never saw, not a decoding error.
        let path = format!(
            "/v2/router/track/{}%3D?no_inflight_updates=false",
            "A".repeat(43)
        );
        let mut track = call(
            "https://127.0.0.1:44710",
            None,
            &path,
            Some("first"),
            10_000,
        );
        track.macaroon = macaroon.clone();
        track.certificate = Some(b64);
        let answer = request(track).await.unwrap();
        assert!(
            answer.lines[0].contains("payment isn't initiated"),
            "{:?}",
            answer.lines
        );

        let (other, _) = certificate();
        let mut wrong = call(
            "https://127.0.0.1:44710",
            Some(&other),
            "/v1/getinfo",
            None,
            10_000,
        );
        wrong.macaroon = macaroon;
        assert!(request(wrong).await.unwrap_err().contains("certificate"));
    }
}

/// The same node over plain HTTP on this machine, where the answers can be cut
/// exactly where a test needs them.
#[cfg(test)]
mod http_tests {
    use super::*;
    use crate::test_support::{closed_port, read_request, tokio_listener, Requests};
    use tokio::io::AsyncWriteExt;

    const MACAROON: &str = "0201036c6e6402f801030a10";

    /// A node that writes `parts` one by one (a pause between them), then keeps the connection open.
    fn node(parts: Vec<Vec<u8>>) -> (String, Requests) {
        let listener = tokio_listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (parts, log) = (parts.clone(), log.clone());
                tokio::spawn(async move {
                    if let Some(request) = read_request(&mut stream).await {
                        log.lock().unwrap().push(request);
                    }
                    for part in parts {
                        if stream.write_all(&part).await.is_err() {
                            return;
                        }
                        let _ = stream.flush().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    tokio::time::sleep(Duration::from_secs(30)).await;
                });
            }
        });
        (url, seen)
    }

    fn unary(body: &str) -> Vec<Vec<u8>> {
        vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()]
    }

    /// A chunked answer whose chunks are exactly `pieces`.
    fn chunked(pieces: &[&str]) -> Vec<Vec<u8>> {
        let mut parts = vec![b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec()];
        for piece in pieces {
            parts.push(format!("{:x}\r\n{piece}\r\n", piece.len()).into_bytes());
        }
        parts
    }

    fn call(url: &str, method: &str, path: &str, body: Option<&str>) -> LndRequest {
        LndRequest {
            url: url.into(),
            macaroon: MACAROON.into(),
            certificate: None,
            method: method.into(),
            path: path.into(),
            body: body.map(Into::into),
            stream: None,
            timeout_ms: 5_000,
        }
    }

    #[tokio::test]
    async fn posts_json_with_the_macaroon_in_its_header_only() {
        let (url, seen) = node(unary(r#"{"payment_request":"lnbcrt1"}"#));
        let answer = request(call(
            &url,
            "POST",
            "/v1/invoices",
            Some(r#"{"value":"1000"}"#),
        ))
        .await
        .unwrap();
        assert_eq!(answer.lines, [r#"{"payment_request":"lnbcrt1"}"#]);
        let (head, body) = seen.lock().unwrap()[0].clone();
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("post /v1/invoices http/1.1"), "{head}");
        assert!(head.contains(&format!("grpc-metadata-macaroon: {MACAROON}")));
        assert!(head.contains("content-type: application/json"));
        assert_eq!(head.matches(MACAROON).count(), 1);
        assert_eq!(body, br#"{"value":"1000"}"#);
    }

    #[tokio::test]
    async fn trims_the_macaroon_and_reads_an_empty_certificate_as_none() {
        let (url, seen) = node(unary("{}"));
        let mut padded = call(&url, "GET", "/v1/getinfo", None);
        padded.macaroon = format!("  {MACAROON}\n");
        padded.certificate = Some("  ".into());
        assert_eq!(request(padded).await.unwrap().status, 200);
        let head = seen.lock().unwrap()[0].0.clone();
        assert!(head.contains(&format!(": {MACAROON}\r\n")), "{head}");
    }

    #[tokio::test]
    async fn refuses_bad_input_before_anything_is_sent() {
        let (url, seen) = node(unary("{}"));
        let with = |edit: &dyn Fn(&mut LndRequest)| {
            let mut request = call(&url, "GET", "/v1/getinfo", None);
            edit(&mut request);
            request
        };
        let cases: Vec<(LndRequest, &str)> = vec![
            (
                with(&|r| r.macaroon = String::new()),
                "The macaroon must be hex",
            ),
            (
                with(&|r| r.macaroon = "   ".into()),
                "The macaroon must be hex",
            ),
            (
                with(&|r| r.macaroon = "a".repeat(MAX_MACAROON_HEX + 1)),
                "The macaroon must be hex",
            ),
            (
                with(&|r| r.certificate = Some("not base64!".into())),
                "The certificate must be base64 DER",
            ),
            (
                with(&|r| {
                    r.method = "POST".into();
                    r.body = Some("x".repeat(MAX_BODY + 1));
                }),
                "Request too large",
            ),
            (
                with(&|r| r.path = "/v1/../../admin".into()),
                "Not an LND REST path",
            ),
            (
                with(&|r| r.path = format!("/v1/{}", "a".repeat(512))),
                "Not an LND REST path",
            ),
            (with(&|r| r.method = "get".into()), "Unsupported method"),
        ];
        for (bad, expected) in cases {
            assert_eq!(request(bad).await.unwrap_err(), expected);
        }
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn plain_http_only_reaches_this_machine() {
        for url in [
            "http://10.0.0.2:8080",
            "http://node.example:8080",
            "http://[::ffff:127.0.0.1]:8080",
        ] {
            assert_eq!(
                request(call(url, "GET", "/v1/getinfo", None))
                    .await
                    .unwrap_err(),
                "The node address must be https (http only on this machine)",
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn an_answer_past_the_limit_is_refused() {
        let body = "x".repeat(MAX_BODY + 1);
        let (url, _) = node(unary(&body));
        assert_eq!(
            request(call(&url, "GET", "/v1/getinfo", None))
                .await
                .unwrap_err(),
            "The node's answer is too large"
        );
    }

    #[tokio::test]
    async fn a_zero_timeout_is_the_shortest_one_not_none() {
        let (url, _) = node(vec![]);
        let mut silent = call(&url, "GET", "/v1/getinfo", None);
        silent.timeout_ms = 0;
        let started = Instant::now();
        assert_eq!(
            request(silent).await.unwrap_err(),
            "The node did not answer in time"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn stream_messages_are_whole_lines_however_the_chunks_cut_them() {
        let (url, _) = node(chunked(&[
            "\n{\"result\":{\"status\":\"IN_",
            "FLIGHT\"}}\n\n{\"result\":{\"status\":\"IN_FLIGHT\"}}\n{\"result\":{\"sta",
            "tus\":\"SUCCEEDED\"}}\n{\"result\":{\"status\":\"never read\"}}\n",
        ]));
        let mut send = call(&url, "POST", "/v2/router/send", Some("{}"));
        send.stream = Some("final".into());
        let answer = request(send).await.unwrap();
        assert_eq!(
            answer.lines,
            [
                r#"{"result":{"status":"IN_FLIGHT"}}"#,
                r#"{"result":{"status":"IN_FLIGHT"}}"#,
                r#"{"result":{"status":"SUCCEEDED"}}"#,
            ]
        );
        assert!(!answer.timed_out);

        let (url, _) = node(chunked(&[
            "{\"result\":{\"status\":\"IN_FLIGHT\"}}\n",
            "{\"error\":{\"code\":2,\"message\":\"invoice expired\"}}\n",
        ]));
        let mut send = call(&url, "POST", "/v2/router/send", Some("{}"));
        send.stream = Some("final".into());
        let answer = request(send).await.unwrap();
        assert_eq!(answer.lines.len(), 2);
        assert!(answer.lines[1].contains("invoice expired"));
    }

    #[tokio::test]
    async fn a_unary_answer_is_one_line_even_when_it_spans_several() {
        let (url, _) = node(unary("{\n  \"alias\": \"pretty\"\n}\n"));
        let answer = request(call(&url, "GET", "/v1/getinfo", None))
            .await
            .unwrap();
        assert_eq!(answer.lines, ["{\n  \"alias\": \"pretty\"\n}"]);
    }

    #[tokio::test]
    async fn an_unreachable_node_is_named_by_neither_its_address_nor_the_macaroon() {
        let port = closed_port();
        let error = request(call(
            &format!("http://127.0.0.1:{port}"),
            "GET",
            "/v1/getinfo",
            None,
        ))
        .await
        .unwrap_err();
        assert!(error.starts_with("Could not reach the node"), "{error}");
        assert!(
            !error.contains(&port.to_string()) && !error.contains(MACAROON),
            "{error}"
        );
    }
}
