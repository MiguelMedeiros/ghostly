//! What a link preview reads (WISP 401 § Link previews), on the sender's side only.
//!
//! The WebView cannot read other sites (CORS). When the person writes a message
//! with a link, the page asks here for that page, its oEmbed answer or its
//! picture, and makes the preview itself. The reader of the message never
//! fetches anything.
//!
//! A page is someone else's: it must not make this machine reach what the
//! person never named. So only http(s) on the default ports is fetched, every
//! name is resolved here and refused when any of its addresses is not public
//! (loopback, private, link-local, …), an address in the URL is checked the
//! same way, redirects are few and checked each time, no proxy is used, and
//! nothing is sent but a plain GET with no cookies. Otherwise a page could point
//! its picture at a device on the local network and the preview would carry
//! that device's image to the contact.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Serialize;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 4;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; Ghostly link preview)";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResponse {
    /// Where the answer came from, after redirects.
    pub url: String,
    pub content_type: String,
    pub body_b64: String,
}

/// What is asked for, and so how much of it is read.
fn limit(kind: &str) -> Option<(usize, &'static str)> {
    match kind {
        // Enough for the head of any page; the rest is cut.
        "page" => Some((
            768 * 1024,
            "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        )),
        "json" => Some((64 * 1024, "application/json")),
        "image" => Some((
            5 * 1024 * 1024,
            "image/jpeg,image/png,image/webp,image/gif;q=0.8",
        )),
        _ => None,
    }
}

/// An address anyone on the internet could reach: not this machine, not the
/// local network, not a range reserved for something else.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 unique local, fe80::/10 link-local, 2001:db8::/32 documentation
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first == 0x2001 && v6.segments()[1] == 0x0db8)
                // ::/96 IPv4-compatible and 64:ff9b::/96 NAT64 can reach IPv4 space: refused whole.
                || v6.segments()[..6].iter().all(|s| *s == 0)
                || (first == 0x0064 && v6.segments()[1] == 0xff9b))
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // 100.64.0.0/10 shared address space (carrier NAT, Tailscale)
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0.0/24 protocol assignments, 198.18.0.0/15 benchmarking, 240.0.0.0/4 reserved
        || (a == 192 && b == 0 && ip.octets()[2] == 0)
        || (a == 198 && (18..20).contains(&b))
        || a >= 240)
}

/// The system resolver, with every non-public answer refused. A name that
/// resolves to any private address is refused whole, so a mix cannot win.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::task::spawn_blocking(move || (host.as_str(), 0).to_socket_addrs())
                    .await
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                    .collect();
            if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
                return Err("not a public address".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// The URL if this side may fetch it: http(s), no credentials, the default
/// port, and a name (or a public address) as its host.
fn allowed(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only web links have previews".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links with credentials have no preview".into());
    }
    if url.port().is_some() {
        return Err("Links to a port have no preview".into());
    }
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            let local = !domain.contains('.')
                || ["localhost", "local", "internal", "lan", "home.arpa"]
                    .iter()
                    .any(|suffix| domain == *suffix || domain.ends_with(&format!(".{suffix}")));
            if local {
                return Err("Local addresses have no preview".into());
            }
            Ok(())
        }
        Some(url::Host::Ipv4(ip)) if is_public(IpAddr::V4(ip)) => Ok(()),
        Some(url::Host::Ipv6(ip)) if is_public(IpAddr::V6(ip)) => Ok(()),
        _ => Err("Local addresses have no preview".into()),
    }
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("Too many redirects")
            } else if let Err(reason) = allowed(attempt.url()) {
                attempt.error(reason)
            } else {
                attempt.follow()
            }
        }))
        .dns_resolver(PublicOnly)
        // A system proxy would do the resolving, past the check above.
        .no_proxy()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// One GET for a preview: `kind` is `page`, `json` or `image`.
pub async fn fetch(url: String, kind: String) -> Result<PreviewResponse, String> {
    let (max, accept) = limit(&kind).ok_or("Unknown kind")?;
    let url = reqwest::Url::parse(&url).map_err(|_| "Invalid link".to_string())?;
    allowed(&url)?;
    let mut response = client()?
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Body: {}", e))? {
        if body.len() + chunk.len() > max {
            // A page is read as far as its head needs; anything else that big is refused.
            if kind == "page" {
                body.extend_from_slice(&chunk[..max - body.len()]);
                break;
            }
            return Err("Too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(PreviewResponse {
        url: final_url,
        content_type,
        body_b64: STANDARD.encode(body),
    })
}

#[cfg(test)]
mod tests {
    // covers: chat.link-preview.compose
    use super::*;

    #[test]
    fn only_public_addresses_are_public() {
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.81.12.32",
            "255.255.255.255",
            "224.0.0.1",
            "198.18.0.1",
            "192.0.0.8",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.0.1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "2001:db8::1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
        for public in ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }

    #[test]
    fn refuses_links_that_name_this_machine_or_the_local_network() {
        for url in [
            "http://localhost/",
            "http://app.localhost/",
            "http://printer.local/",
            "http://router/",
            "http://nas.lan/",
            "http://box.home.arpa/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://192.168.0.1/",
            "http://[::ffff:10.0.0.1]/",
            "http://example.com:8080/",
            "http://user:pw@example.com/",
            "ftp://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(allowed(&parsed).is_err(), "{url}");
        }
        for url in ["https://example.com/a?b=c", "http://93.184.215.14/"] {
            assert!(allowed(&reqwest::Url::parse(url).unwrap()).is_ok(), "{url}");
        }
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_this_machine_is_never_reached() {
        // A public-looking name can still point here (DNS is the page's to set): the resolver refuses it.
        let refused = PublicOnly.resolve("localhost".parse().unwrap()).await;
        assert!(refused.is_err());
        let error = fetch("https://example.com/".into(), "script".into())
            .await
            .unwrap_err();
        assert_eq!(error, "Unknown kind");
    }
}
