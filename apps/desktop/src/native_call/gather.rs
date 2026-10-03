//! The ICE candidates a description waits for, and the STUN server they are gathered from. Apart from
//! [`engine`](super::engine) so it is tested on every platform: nothing here needs WebRTC or GStreamer.
//!
//! Why the STUN server goes to webrtc-rs as an address and not a name: its driver gathers on its own task,
//! and it resolves the server's name there, once per local socket, one after the other, before the host
//! candidates it has already made reach the handler. On a cold resolver (the first call after a start, or a
//! router that drops AAAA queries, where each lookup waits out a 5 s timeout) the description waited its whole
//! bound and went out with no candidate at all, and the call could not connect. Resolved here, with its own
//! bound, the driver has no lookup to make, and the host candidates arrive at once.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// How long a description waits for its candidates, as `waitForIceGathering` does in a browser.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    /// For the server reflexive candidate.
    pub reflexive: Duration,
    /// After the reflexive candidate, for the others that come with it.
    pub settle: Duration,
    /// For a first candidate of any kind, when the reflexive wait ran out with none. Past this, no
    /// description: one with no candidate cannot connect.
    pub first: Duration,
}

pub const BOUNDS: Bounds = Bounds {
    reflexive: Duration::from_secs(10),
    settle: Duration::from_millis(400),
    first: Duration::from_secs(30),
};

/// The candidates gathered so far, and whether gathering is complete; told by the peer connection's handler.
#[derive(Default)]
pub struct Gathering {
    candidates: Mutex<(Vec<String>, bool)>,
    changed: Notify,
}

impl Gathering {
    pub fn add(&self, candidate: String) {
        {
            let mut candidates = self.candidates.lock().unwrap();
            if !candidate.is_empty() && !candidates.0.contains(&candidate) {
                candidates.0.push(candidate);
            }
        }
        self.changed.notify_waiters();
    }

    pub fn complete(&self) {
        self.candidates.lock().unwrap().1 = true;
        self.changed.notify_waiters();
    }

    /// Forgets the candidates gathered so far: the description being made waits for this round's own.
    pub fn anew(&self) {
        *self.candidates.lock().unwrap() = (Vec::new(), false);
    }

    /// The candidates worth sending: until the reflexive one and a moment more, or complete. Never none:
    /// with nothing gathered when the reflexive wait runs out (or gathering says complete), it waits on for
    /// the first candidate, and past [`Bounds::first`] it is an error.
    pub async fn wait(&self, bounds: Bounds) -> Result<Vec<String>, String> {
        let started = Instant::now();
        let mut reflexive_at: Option<Instant> = None;
        loop {
            let changed = self.changed.notified();
            let now = Instant::now();
            {
                let candidates = self.candidates.lock().unwrap();
                let (gathered, complete) = &*candidates;
                if reflexive_at.is_none() && gathered.iter().any(|c| c.contains(" typ srflx")) {
                    reflexive_at = Some(now);
                }
                let deadline = match reflexive_at {
                    Some(at) => at + bounds.settle,
                    None => started + bounds.reflexive,
                };
                if !gathered.is_empty() && (*complete || now >= deadline) {
                    return Ok(gathered.clone());
                }
                if gathered.is_empty() && now >= started + bounds.first {
                    return Err(format!(
                        "No ICE candidate gathered in {} ms",
                        started.elapsed().as_millis()
                    ));
                }
            }
            let deadline = match reflexive_at {
                Some(at) => at + bounds.settle,
                None if now < started + bounds.reflexive => started + bounds.reflexive,
                // Nothing yet, the reflexive wait over or gathering complete: the first candidate.
                None => started + bounds.first,
            };
            let _ = tokio::time::timeout(deadline.saturating_duration_since(now), changed).await;
        }
    }
}

/// The STUN server's URLs by address, one per address family, IPv4 first. `stun` is a `stun:host:port`
/// URL; `lookup` resolves its `host:port`. When the lookup fails or takes longer than `bound`, the URL as
/// it is: webrtc-rs then resolves it itself, as before, and [`Gathering::wait`] still holds the description
/// until a candidate arrives.
pub async fn stun_urls<F>(
    stun: &str,
    lookup: impl FnOnce(String) -> F,
    bound: Duration,
) -> Vec<String>
where
    F: Future<Output = io::Result<Vec<SocketAddr>>>,
{
    let host = stun.strip_prefix("stun:").unwrap_or(stun).to_owned();
    match tokio::time::timeout(bound, lookup(host)).await {
        Ok(Ok(addresses)) => {
            let v4 = addresses.iter().find(|a| a.is_ipv4());
            let v6 = addresses.iter().find(|a| a.is_ipv6());
            let urls: Vec<String> = v4
                .into_iter()
                .chain(v6)
                .map(|a| format!("stun:{a}"))
                .collect();
            if urls.is_empty() {
                vec![stun.to_owned()]
            } else {
                urls
            }
        }
        Ok(Err(error)) => {
            crate::diagnostics::log(&format!("native call: STUN server not resolved: {error}"));
            vec![stun.to_owned()]
        }
        Err(_) => {
            crate::diagnostics::log(&format!(
                "native call: STUN server not resolved in {} ms",
                bound.as_millis()
            ));
            vec![stun.to_owned()]
        }
    }
}

/// Resolves `host:port` with the system's resolver, on a blocking thread.
pub async fn resolve(host: String) -> io::Result<Vec<SocketAddr>> {
    tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        host.to_socket_addrs().map(|addresses| addresses.collect())
    })
    .await
    .map_err(io::Error::other)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const HOST: &str = "candidate:1 1 udp 2130706431 192.168.0.13 40000 typ host";
    const REFLEXIVE: &str =
        "candidate:2 1 udp 1694498815 203.0.113.7 40000 typ srflx raddr 192.168.0.13 rport 40000";

    fn bounds() -> Bounds {
        Bounds {
            reflexive: Duration::from_millis(100),
            settle: Duration::from_millis(20),
            first: Duration::from_millis(600),
        }
    }

    /// The Linux Desktop's offer that went out with no candidate: the host candidates came after the
    /// reflexive wait had run out. The description waits for them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_host_candidate_after_the_reflexive_wait_is_still_sent() {
        let gathering = Arc::new(Gathering::default());
        let late = gathering.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            late.add(HOST.into());
        });
        let started = Instant::now();
        assert_eq!(gathering.wait(bounds()).await, Ok(vec![HOST.to_string()]));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn nothing_gathered_is_an_error_and_not_an_empty_description() {
        let gathering = Gathering::default();
        let started = Instant::now();
        let waited = gathering.wait(bounds()).await;
        assert!(waited.is_err(), "{waited:?}");
        assert!(
            started.elapsed() >= Duration::from_millis(600),
            "{:?}",
            started.elapsed()
        );

        // Complete with nothing (a complete left from the round before): still the first candidate.
        let gathering = Arc::new(Gathering::default());
        gathering.complete();
        let late = gathering.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            late.add(HOST.into());
        });
        assert_eq!(gathering.wait(bounds()).await, Ok(vec![HOST.to_string()]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_host_candidate_waits_for_the_reflexive_one_and_a_moment_more() {
        let gathering = Arc::new(Gathering::default());
        gathering.add(HOST.into());
        let late = gathering.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            late.add(REFLEXIVE.into());
        });
        let started = Instant::now();
        let gathered = gathering.wait(bounds()).await.unwrap();
        assert_eq!(gathered, vec![HOST.to_string(), REFLEXIVE.to_string()]);
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(50) && waited < Duration::from_millis(100),
            "{waited:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_host_candidate_alone_goes_when_no_reflexive_one_comes() {
        let gathering = Gathering::default();
        gathering.add(HOST.into());
        gathering.add(HOST.into());
        gathering.add(String::new());
        let started = Instant::now();
        assert_eq!(gathering.wait(bounds()).await, Ok(vec![HOST.to_string()]));
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(100) && waited < Duration::from_millis(300),
            "{waited:?}"
        );

        gathering.anew();
        gathering.add(REFLEXIVE.into());
        gathering.complete();
        assert_eq!(
            gathering.wait(bounds()).await,
            Ok(vec![REFLEXIVE.to_string()])
        );
    }

    #[tokio::test]
    async fn the_stun_server_goes_by_address_ipv4_first() {
        let lookup = |host: String| async move {
            assert_eq!(host, "stun.l.google.com:19302");
            Ok(vec![
                "[2001:4860:4864:5:8000::1]:19302".parse().unwrap(),
                "74.125.250.129:19302".parse().unwrap(),
                "74.125.250.130:19302".parse().unwrap(),
            ])
        };
        let urls = stun_urls(
            "stun:stun.l.google.com:19302",
            lookup,
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(
            urls,
            [
                "stun:74.125.250.129:19302",
                "stun:[2001:4860:4864:5:8000::1]:19302"
            ]
        );
    }

    #[tokio::test]
    async fn a_lookup_that_fails_or_hangs_leaves_the_name() {
        let stun = "stun:stun.l.google.com:19302";
        let failed = |_| async { Err(io::Error::other("no network")) };
        assert_eq!(
            stun_urls(stun, failed, Duration::from_secs(1)).await,
            [stun]
        );
        let started = Instant::now();
        let hangs = |_| std::future::pending();
        assert_eq!(
            stun_urls(stun, hangs, Duration::from_millis(50)).await,
            [stun]
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        let nothing = |_| async { Ok(vec![]) };
        assert_eq!(
            stun_urls(stun, nothing, Duration::from_secs(1)).await,
            [stun]
        );
    }
}
