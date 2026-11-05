//! Held items (WISP 404): reads a held item or manifest from the storage address a contact chose, for the engine's
//! pickup (apps/ui/src/desktop/holdFetch.ts).
//!
//! The contact names that address and this device reads it on its own, so the WebView's `fetch` will not do: it
//! cannot see what a name resolves to, and a name the contact points at this machine or its network would be reached.
//! Here the name is resolved and refused when any of its addresses is not public, when the connection is made (so a
//! name that changes its answer in between is refused too), as the CLI's does (packages/cli/src/runtime/holdFetch.ts).
//! A plain GET over HTTPS: no redirect followed, no proxy, no cookies, a bounded body. The engine checks the rest.

use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::dns::Resolve;
use serde::Serialize;

use crate::link_preview::{is_public, PublicOnly};

/// The largest held item: one bundle (`HOLD_LIMITS.maxBundleBytes`, packages/core/src/storeForward.ts).
const MAX_BODY: usize = 8 * 1024 * 1024;
/// Past the engine's own limit for the largest item (`holdFetchTimeoutMs`, packages/browser/src/engine/hold.ts).
const TIMEOUT: Duration = Duration::from_secs(150);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldResponse {
    pub status: u16,
    /// Empty for any status but 2xx: the engine refuses those without reading them.
    pub body_b64: String,
}

/// The address if this device may read it: https, no credentials, a name or a public address. The engine has checked
/// it already (`isHoldUrl`); this is what Rust holds to whoever asks.
fn allowed(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("The storage address is not https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The storage address carries credentials".into());
    }
    match url.host() {
        Some(url::Host::Domain(_)) => Ok(()),
        Some(url::Host::Ipv4(ip)) if is_public(IpAddr::V4(ip)) => Ok(()),
        Some(url::Host::Ipv6(ip)) if is_public(IpAddr::V6(ip)) => Ok(()),
        _ => Err("The storage address is a local one".into()),
    }
}

fn build<R: Resolve + 'static>(resolver: R) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A redirect is answered as it came: the engine refuses any status but 2xx.
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(resolver)
        // A system proxy would do the resolving, past the check.
        .no_proxy()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = build(PublicOnly)?;
    Ok(CLIENT.get_or_init(|| client))
}

/// What went wrong, with its causes (the resolver's refusal is one), never the address: a presigned one is a secret.
fn reason(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        text = format!("{text}: {cause}");
        source = cause.source();
    }
    text
}

async fn get(client: &reqwest::Client, url: reqwest::Url) -> Result<HoldResponse, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", reason(e)))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Ok(HoldResponse {
            status,
            body_b64: String::new(),
        });
    }
    let too_large = || "The held item is too large".to_string();
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Body: {}", reason(e)))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HoldResponse {
        status,
        body_b64: STANDARD.encode(body),
    })
}

/// One GET of a held item or manifest at `url`, on public addresses only.
pub async fn fetch(url: String) -> Result<HoldResponse, String> {
    let url =
        reqwest::Url::parse(&url).map_err(|_| "The storage address is not a URL".to_string())?;
    allowed(&url)?;
    get(client()?, url).await
}

#[cfg(test)]
mod tests {
    // covers: delivery.hold.protocol
    use super::*;
    use crate::link_preview::only_public;
    use reqwest::dns::{Addrs, Name, Resolving};
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// What a name the contact set up answers, held to public addresses as the app's own resolver holds them.
    struct Answers(Vec<IpAddr>);

    impl Resolve for Answers {
        fn resolve(&self, _name: Name) -> Resolving {
            let addrs = self.0.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
            Box::pin(async move { only_public(addrs) })
        }
    }

    /// A public storage host, played by this machine: no check, so a test server can stand in for it.
    struct Storage;

    impl Resolve for Storage {
        fn resolve(&self, _name: Name) -> Resolving {
            Box::pin(async {
                Ok(Box::new(vec![SocketAddr::from(([127, 0, 0, 1], 0))].into_iter()) as Addrs)
            })
        }
    }

    /// A server on this machine that answers every request with `answer`; how many connections it took.
    async fn serve(answer: &'static [u8]) -> (u16, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let taken = Arc::new(AtomicUsize::new(0));
        let count = taken.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request).await;
                let _ = stream.write_all(answer).await;
                let _ = stream.shutdown().await;
            }
        });
        (port, taken)
    }

    fn at(port: u16) -> reqwest::Url {
        reqwest::Url::parse(&format!(
            "http://storage.example.com:{port}/b/o?X-Amz-Signature=s"
        ))
        .unwrap()
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_this_machine_or_its_network_is_never_reached() {
        let (port, taken) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nheld").await;
        for answers in [
            vec!["127.0.0.1"],
            vec!["10.0.0.5"],
            vec!["192.168.1.1"],
            vec!["100.64.0.1"],
            vec!["169.254.169.254"],
            vec!["::1"],
            vec!["fe80::1"],
            vec!["fd00::1"],
            vec!["::ffff:127.0.0.1"],
            vec!["::ffff:10.0.0.5"],
            // A private address among public ones refuses the name whole.
            vec!["93.184.215.14", "192.168.1.1"],
        ] {
            let client = build(Answers(
                answers.iter().map(|a| a.parse().unwrap()).collect(),
            ))
            .unwrap();
            let error = get(&client, at(port)).await.err();
            assert!(
                error
                    .as_deref()
                    .is_some_and(|e| e.contains("not a public address")),
                "{answers:?}: {error:?}"
            );
            // The resolver answered, then nothing was connected to.
            assert!(!error.unwrap().contains("X-Amz-Signature"));
        }
        assert_eq!(taken.load(Ordering::SeqCst), 0);
        // The same check lets a public name through.
        for public in [
            vec!["93.184.215.14"],
            vec!["2606:4700:4700::1111", "1.1.1.1"],
        ] {
            let addrs = public
                .iter()
                .map(|a| SocketAddr::new(a.parse().unwrap(), 0))
                .collect();
            assert!(only_public(addrs).is_ok(), "{public:?}");
        }
    }

    #[tokio::test]
    async fn the_app_s_own_resolver_refuses_this_machine() {
        // The shipped path: `localhost` resolves here, with no network, to loopback only.
        let error = fetch("https://localhost/b/o".into()).await.unwrap_err();
        assert!(error.contains("not a public address"), "{error}");
    }

    #[tokio::test]
    async fn a_public_storage_is_read_and_a_redirect_is_not_followed() {
        let (port, _) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nheld").await;
        let read = get(&build(Storage).unwrap(), at(port)).await.unwrap();
        assert_eq!(read.status, 200);
        assert_eq!(STANDARD.decode(read.body_b64).unwrap(), b"held");

        let (port, taken) = serve(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n",
        )
        .await;
        let moved = get(&build(Storage).unwrap(), at(port)).await.unwrap();
        assert_eq!((moved.status, moved.body_b64.as_str()), (302, ""));
        assert_eq!(taken.load(Ordering::SeqCst), 1);

        let (port, _) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 9000000\r\n\r\n").await;
        let error = get(&build(Storage).unwrap(), at(port)).await.unwrap_err();
        assert_eq!(error, "The held item is too large");
    }

    #[tokio::test]
    async fn only_https_without_credentials_at_a_name_or_a_public_address() {
        for refused in [
            "http://s3.example.com/b/o",
            "https://user:pw@s3.example.com/b/o",
            "https://127.0.0.1/b/o",
            "https://10.0.0.5/b/o",
            "https://[::1]/b/o",
            "https://[fe80::1]/b/o",
            "https://[::ffff:192.168.0.1]/b/o",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(fetch(refused.into()).await.is_err(), "{refused}");
        }
        for url in ["https://s3.example.com/b/o", "https://93.184.215.14/b/o"] {
            assert!(allowed(&reqwest::Url::parse(url).unwrap()).is_ok(), "{url}");
        }
    }
}
