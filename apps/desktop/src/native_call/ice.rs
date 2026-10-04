//! The profile's own ICE servers for a native call (Settings, Network: a TURN server, typically), as the page
//! passes them to `native_call_open`. The same rules as the page's (`iceServerProblem` in
//! packages/browser/src/shared/ice.ts): `stun:`, `turn:` or `turns:` with a host and an optional port, and
//! `?transport=udp|tcp` at most; a TURN server needs its username and credential. A server that breaks them is
//! left out, not the call: the built-in STUN server still gives the call its direct paths.
//!
//! The credential is a secret: it never appears in a log line or an error, and `Debug` leaves it out.
//!
//! Built on every platform (the command takes the servers everywhere), used only where calls are native.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde::Deserialize;

/// At most this many servers, and this many URLs in one, as a device record keeps them (WISP 06).
pub const MAX_SERVERS: usize = 8;
pub const MAX_URLS: usize = 8;
/// The longest URL, username or credential taken.
const MAX_TEXT: usize = 512;

/// One server as the page sends it: its URLs, and for TURN the username and credential.
#[derive(Deserialize, Clone, Default)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

impl std::fmt::Debug for IceServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IceServer")
            .field("urls", &self.urls)
            .field("username", &self.username.as_ref().map(|_| "<set>"))
            .field("credential", &self.credential.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

/// Whether a URL is one ICE can use: `stun:`, `turn:` or `turns:`, a host (and port), and nothing else but a
/// transport.
fn usable_url(url: &str) -> bool {
    if url.len() > MAX_TEXT {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let Some(rest) = ["stun:", "turn:", "turns:"]
        .iter()
        .find_map(|scheme| lower.strip_prefix(scheme))
    else {
        return false;
    };
    let (host, query) = match rest.split_once('?') {
        Some((host, query)) => (host, Some(query)),
        None => (rest, None),
    };
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#'))
    {
        return false;
    }
    match query {
        None => true,
        Some(query) => matches!(query, "transport=udp" | "transport=tcp"),
    }
}

fn is_turn(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("turn:") || lower.starts_with("turns:")
}

fn filled(text: &Option<String>) -> bool {
    text.as_deref()
        .is_some_and(|t| !t.trim().is_empty() && t.len() <= MAX_TEXT)
}

/// The servers a call may use, in order: the first [`MAX_SERVERS`], each with every one of its URLs usable, and
/// a TURN one with its username and credential. Anything else is left out.
pub fn usable(servers: &[IceServer]) -> Vec<IceServer> {
    servers
        .iter()
        .take(MAX_SERVERS)
        .filter(|server| {
            !server.urls.is_empty()
                && server.urls.len() <= MAX_URLS
                && server.urls.iter().all(|url| usable_url(url))
                && (!server.urls.iter().any(|url| is_turn(url))
                    || (filled(&server.username) && filled(&server.credential)))
        })
        .cloned()
        .collect()
}

/// Whether a TURN server is among them: gathering then waits for a relay candidate, as the page's
/// `waitForIceGathering` does, rather than leave with the reflexive one.
pub fn uses_turn(servers: &[IceServer]) -> bool {
    servers
        .iter()
        .any(|s| s.urls.iter().any(|url| is_turn(url)))
}

#[cfg(test)]
mod tests {
    // covers: settings.network.turn
    use super::*;

    fn server(urls: &[&str], username: Option<&str>, credential: Option<&str>) -> IceServer {
        IceServer {
            urls: urls.iter().map(|u| u.to_string()).collect(),
            username: username.map(str::to_owned),
            credential: credential.map(str::to_owned),
        }
    }

    #[test]
    fn keeps_servers_the_page_would_take() {
        let good = [
            server(&["turn:turn.example.org:3478"], Some("u"), Some("c")),
            server(
                &["turns:turn.example.org:5349?transport=tcp"],
                Some("u"),
                Some("c"),
            ),
            server(&["stun:stun.example.org:3478"], None, None),
            server(
                &[
                    "stun:a.example.org",
                    "TURN:b.example.org:3478?transport=udp",
                ],
                Some("u"),
                Some("c"),
            ),
        ];
        assert_eq!(usable(&good).len(), good.len());
    }

    #[test]
    fn leaves_out_the_rest() {
        let bad = [
            server(&["turn:turn.example.org:3478"], None, None),
            server(&["turn:turn.example.org:3478"], Some("u"), Some("  ")),
            server(&["turn.example.org:3478"], Some("u"), Some("c")),
            server(&["https://turn.example.org"], Some("u"), Some("c")),
            server(&["turn:"], Some("u"), Some("c")),
            server(&["turn:host/path"], Some("u"), Some("c")),
            server(&["stun:host?x=1"], None, None),
            server(&["turn:host?x=1"], Some("u"), Some("c")),
            server(&[], None, None),
        ];
        assert!(usable(&bad).is_empty());
        let many = vec![server(&["stun:a.example.org"], None, None); MAX_SERVERS + 3];
        assert_eq!(usable(&many).len(), MAX_SERVERS);
    }

    #[test]
    fn a_turn_server_makes_gathering_wait_for_a_relay() {
        assert!(!uses_turn(&[server(&["stun:a.example.org"], None, None)]));
        assert!(uses_turn(&[server(
            &["stun:a.example.org", "turns:b.example.org"],
            Some("u"),
            Some("c")
        )]));
    }

    #[test]
    fn debug_never_shows_the_credential() {
        let shown = format!(
            "{:?}",
            server(
                &["turn:turn.example.org:3478"],
                Some("ghost"),
                Some("s3cret-value")
            )
        );
        assert!(!shown.contains("s3cret-value"), "{shown}");
        assert!(!shown.contains("ghost"), "{shown}");
        assert!(shown.contains("turn:turn.example.org:3478"), "{shown}");
    }
}
