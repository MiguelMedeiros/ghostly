//! Bounded, main-window-only bridge for native paired channels. No application
//! identities or receipts live here: those remain in the shared paired engine.
use base64::Engine;
use futures_util::{Stream, StreamExt};
use ghostly_transports::iroh_transport as wire;
use iroh::{
    dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData},
    endpoint::Connection,
    Endpoint, Watcher,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Open {
        id: u64,
        binding: wire::Binding,
        incoming: bool,
    },
    Frame {
        id: u64,
        text: String,
    },
    /// A binary message (WISP 102 § Frames), in base64, as HyperDHT's (`hyperdht.rs`).
    #[serde(rename = "frame")]
    Binary {
        id: u64,
        bytes: String,
    },
    Closed {
        id: u64,
    },
    /// The endpoint's own address, when it came to be another.
    Address {
        descriptor: wire::Address,
    },
    /// The endpoint is connected to its home relay again, after it lost it (`tell_relay_back`).
    RelayBack {},
}
/// A frame for the stream (its bytes, and whether it is a binary message), and who hears once it is written there.
type Outgoing = (Vec<u8>, bool, oneshot::Sender<()>);
struct Socket {
    connection: Connection,
    tx: mpsc::Sender<Outgoing>,
    /// The page's word for the app's exit on this connection (`paired_native_parting`), sent by `part`.
    parting: Option<String>,
}
struct Peer {
    endpoint: Endpoint,
    /// The relays it was started on (none: n0's public ones), the only non-public ones a contact is dialled through.
    relays: Vec<String>,
    events: Channel<Event>,
    listener: tokio::task::JoinHandle<()>,
    watcher: tokio::task::JoinHandle<()>,
}
impl Peer {
    /// Nothing more is accepted on it or said about it.
    fn silence(&self) {
        self.listener.abort();
        self.watcher.abort();
    }
}

/// How long an address is left to settle before the page is told: a network change moves the home relay and the
/// direct addresses one after the other, and each word to the page is a record published again.
const ADDRESS_SETTLES: Duration = Duration::from_secs(1);

/// Tells the page the endpoint's address each time it came to be another than the last one `said`, so the page
/// never asks. `changes` yields when something about the address moved (Iroh's own watcher), `current` reads it.
async fn tell_address(
    mut changes: impl Stream + Unpin,
    current: impl Fn() -> wire::Address,
    mut said: wire::Address,
    events: Channel<Event>,
) {
    while changes.next().await.is_some() {
        tokio::time::sleep(ADDRESS_SETTLES).await;
        let descriptor = current();
        if descriptor == said {
            continue;
        }
        said = descriptor.clone();
        if events.send(Event::Address { descriptor }).is_err() {
            break;
        }
    }
}
/// Tells the page each time the endpoint is connected to a home relay again after it lost every one: `connected` yields
/// whether any is, each time that may have changed (Iroh's `home_relay_status`), and `up` is how it was at the start.
async fn tell_relay_back(
    mut connected: impl Stream<Item = bool> + Unpin,
    mut up: bool,
    events: Channel<Event>,
) {
    // Homing on a relay for the first time is not being back on one.
    let mut ever = up;
    while let Some(now) = connected.next().await {
        if now && !up && ever {
            crate::diagnostics::log("iroh: back on its home relay");
            if events.send(Event::RelayBack {}).is_err() {
                break;
            }
        }
        ever |= now;
        up = now;
    }
}

#[derive(Default)]
struct Inner {
    peers: HashMap<u64, Peer>,
    sockets: HashMap<u64, (u64, Socket)>,
    /// Which page of the Ghostly window this is, counted from the app's start (`page_started`).
    page: u64,
}
#[derive(Clone, Default)]
pub struct TransportState {
    inner: Arc<Mutex<Inner>>,
    next: Arc<AtomicU64>,
}
#[derive(Serialize)]
pub struct Started {
    id: u64,
    descriptor: wire::Address,
}

impl TransportState {
    fn next(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }
    async fn attach(
        &self,
        peer: u64,
        endpoint: Endpoint,
        connection: Connection,
        events: Channel<Event>,
        incoming: bool,
    ) -> Result<u64, String> {
        let binding = wire::binding(&endpoint, &connection)?;
        // Opening a QUIC stream alone does not make it visible to the peer.
        // A fixed protocol preface makes accept_bi observable before UI offers.
        let (mut send, mut recv) = tokio::time::timeout(Duration::from_secs(10), async {
            if incoming {
                let (send, mut recv) = connection.accept_bi().await.map_err(|e| e.to_string())?;
                if wire::read_frame(&mut recv).await? != b"ghostly/paired-chat/1" {
                    return Err("Invalid stream preface".to_string());
                }
                Ok((send, recv))
            } else {
                let (mut send, recv) = connection.open_bi().await.map_err(|e| e.to_string())?;
                wire::write_frame(&mut send, b"ghostly/paired-chat/1").await?;
                Ok((send, recv))
            }
        })
        .await
        .map_err(|_| "Native stream timed out")??;
        let id = self.next();
        let (tx, mut rx) = mpsc::channel::<Outgoing>(32);
        {
            let mut inner = self.inner.lock().unwrap();
            if !inner.peers.contains_key(&peer)
                || inner.sockets.values().filter(|(p, _)| *p == peer).count() >= 2
            {
                connection.close(1u32.into(), b"connection limit");
                return Err("Native connection limit reached".into());
            }
            inner.sockets.insert(
                id,
                (
                    peer,
                    Socket {
                        connection: connection.clone(),
                        tx,
                        parting: None,
                    },
                ),
            );
        }
        if events
            .send(Event::Open {
                id,
                binding,
                incoming,
            })
            .is_err()
        {
            self.close(id);
            return Err("Native UI unavailable".into());
        }
        let state = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = async { while let Some((frame, binary, written)) = rx.recv().await { wire::write_message(&mut send, &frame, binary).await?; let _ = written.send(()); } Ok::<(), String>(()) } => {},
                _ = async { loop { let (frame, binary) = wire::read_message(&mut recv).await?; let event = if binary { Event::Binary { id, bytes: base64::engine::general_purpose::STANDARD.encode(frame) } } else { Event::Frame { id, text: String::from_utf8(frame).map_err(|_| "Non-text paired frame")? } }; events.send(event).map_err(|_| "Native UI unavailable")?; } #[allow(unreachable_code)] Ok::<(), String>(()) } => {},
                _ = connection.closed() => {},
            }
            state.close(id);
            let _ = events.send(Event::Closed { id });
        });
        Ok(id)
    }
    fn close(&self, id: u64) {
        if let Some((_, socket)) = self.inner.lock().unwrap().sockets.remove(&id) {
            socket.connection.close(0u32.into(), b"closed");
        }
    }
    /// The app is exiting: every connection is closed and every endpoint stopped, so each contact's
    /// app hears a close at once (QUIC's CONNECTION_CLOSE) instead of timing out 30 s later, and
    /// starts watching for this app to come back. Bounded by `within`: exiting never waits on a
    /// relay that does not answer.
    /// The app is about to exit: what the page left to be said on each connection (`paired_native_parting`, a call's
    /// hang-up) goes now, after whatever it sent, so the contact hears it even when the page is gone (a logout ends
    /// WebKit's processes with the app). Each goes once. Returns once every one is written on its stream.
    pub async fn part(&self) {
        let partings: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .sockets
            .values_mut()
            .filter_map(|(_, socket)| Some((socket.tx.clone(), socket.parting.take()?)))
            .collect();
        futures_util::future::join_all(partings.into_iter().map(|(tx, text)| async move {
            let (written, done) = oneshot::channel();
            if tx.send((text.into_bytes(), false, written)).await.is_ok() {
                let _ = done.await;
            }
        }))
        .await;
    }
    pub async fn shutdown(&self, within: Duration) {
        let peers = self.release(b"app exiting");
        let closing = close_all(peers);
        let _ = tokio::time::timeout(within, closing).await;
    }
    /// Every connection closed and every endpoint off the books, now; the endpoints are the caller's to close.
    fn release(&self, why: &'static [u8]) -> Vec<Peer> {
        let mut inner = self.inner.lock().unwrap();
        inner.page += 1;
        for (_, (_, socket)) in inner.sockets.drain() {
            socket.connection.close(0u32.into(), why);
        }
        inner.peers.drain().map(|(_, peer)| peer).collect()
    }
    /// The Ghostly window's page starts: the app opening, the page loaded again (another profile, Clear all data, a
    /// device that became a standby), or the WebView back after its process died. The page before it held the
    /// endpoints by ids only it knew, and it may have gone without stopping one (its process died, a stop asked for
    /// as the page went never arrived, a listener was still starting): nothing here would ever stop them, and with
    /// eight left behind no chat of the new page gets a listener. So they are off the books before the new page asks,
    /// each contact hears the close at once, and the endpoints are closed in the background.
    pub fn page_started(&self) {
        let peers = self.release(b"page gone");
        if !peers.is_empty() {
            tauri::async_runtime::spawn(close_all(peers));
        }
    }
    /// The network changed (Android's own callback: there Iroh's netwatch may not see it, denied the routing table):
    /// every endpoint looks again at its addresses and paths now. Returns how many were told.
    #[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
    pub async fn network_changed(&self) -> usize {
        let endpoints: Vec<Endpoint> = {
            let inner = self.inner.lock().unwrap();
            inner
                .peers
                .values()
                .map(|peer| peer.endpoint.clone())
                .collect()
        };
        for endpoint in &endpoints {
            endpoint.network_change().await;
        }
        endpoints.len()
    }
    /// Binds an endpoint for `seed` and accepts on it. `local_only` keeps it on
    /// this machine's loopback, with no relay (tests). `relays`, when there are
    /// any, home it on those Iroh relays instead of n0's (`iroh_relays`).
    async fn start(
        &self,
        seed: [u8; 32],
        events: Channel<Event>,
        local_only: bool,
        relays: &[String],
    ) -> Result<Started, String> {
        let page = {
            let inner = self.inner.lock().unwrap();
            if inner.peers.len() >= 8 {
                return Err("Native endpoint limit reached".into());
            }
            inner.page
        };
        let relays_given = relays.to_vec();
        let endpoint = if relays.is_empty() || local_only {
            let own: Vec<String> = wire::default_relays()
                .urls::<Vec<_>>()
                .iter()
                .map(|url| url.to_string())
                .collect();
            wire::endpoint(seed, local_only, Some(relay_dns(&own, DnsResolver::new()))).await?
        } else {
            wire::endpoint_with_relays(seed, relays, Some(relay_dns(relays, DnsResolver::new())))
                .await?
        };
        let id = self.next();
        let descriptor = wire::address(&endpoint);
        let listener_endpoint = endpoint.clone();
        let listener_state = self.clone();
        let listener_events = events.clone();
        let listener = tokio::spawn(async move {
            while let Some(incoming) = listener_endpoint.accept().await {
                // Serial admission bounds unfinished handshakes, even before a socket exists.
                if let Ok(Ok(connection)) =
                    tokio::time::timeout(Duration::from_secs(10), incoming).await
                {
                    let _ = listener_state
                        .attach(
                            id,
                            listener_endpoint.clone(),
                            connection,
                            listener_events.clone(),
                            true,
                        )
                        .await;
                }
            }
        });
        let mut inner = self.inner.lock().unwrap();
        // The page that asked is gone (another one started while this endpoint was binding): nobody holds its id.
        if inner.page != page {
            listener.abort();
            tauri::async_runtime::spawn(async move { endpoint.close().await });
            return Err("The page that asked for this endpoint is gone".into());
        }
        if inner.peers.len() >= 8 {
            listener.abort();
            return Err("Native endpoint limit reached".into());
        }
        let watched = endpoint.clone();
        let mut relays = endpoint.home_relay_status();
        let on_relay = |statuses: Vec<iroh::endpoint::RelayStatus>| {
            statuses.iter().any(|status| status.is_connected())
        };
        let (address, relay_back) = (
            tell_address(
                endpoint.watch_addr().stream_updates_only(),
                move || wire::address(&watched),
                descriptor.clone(),
                events.clone(),
            ),
            tell_relay_back(
                relays.clone().stream_updates_only().map(on_relay),
                on_relay(relays.get()),
                events.clone(),
            ),
        );
        let watcher = tokio::spawn(async move {
            tokio::join!(address, relay_back);
        });
        inner.peers.insert(
            id,
            Peer {
                endpoint,
                relays: relays_given,
                events,
                listener,
                watcher,
            },
        );
        Ok(Started { id, descriptor })
    }
}

async fn close_all(peers: Vec<Peer>) {
    let mut closing = tokio::task::JoinSet::new();
    for peer in peers {
        peer.silence();
        closing.spawn(async move { peer.endpoint.close().await });
    }
    while closing.join_next().await.is_some() {}
}

/// The Iroh relays an endpoint homes on: the person's (Settings, Network, as
/// the web app's Iroh does), else `GHOSTLY_IROH_RELAYS` (comma separated: a
/// self-hosted or test `iroh-relay`), else none, which is n0's public relays.
fn iroh_relays(given: Option<Vec<String>>, env: Option<&str>) -> Vec<String> {
    let given: Vec<String> = given
        .unwrap_or_default()
        .iter()
        .map(|relay| relay.trim().to_string())
        .filter(|relay| !relay.is_empty())
        .collect();
    if !given.is_empty() {
        return given;
    }
    env.unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|relay| !relay.is_empty())
        .map(String::from)
        .collect()
}

/// Whether a contact is dialled through the relay its descriptor names (none: its direct addresses alone). The contact
/// chose it and this device opens it on its own, again on each redial: https at a public name or a public address, as
/// a held item's address is (`isHoldUrl`, packages/core/src/storeForward.ts), or one of the endpoint's own relays
/// (`own`: the person's, a private network's or a test's) in either spelling. The page checks the same
/// (`dialableIrohRelay`, packages/core/src/pairedTransports.ts); this is what Rust holds to whoever asks.
fn dialable_relay(relay: Option<&str>, own: &[String]) -> bool {
    let Some(relay) = relay else { return true };
    let spelled = |value: &str| {
        let mut url = url::Url::parse(value).ok()?;
        if let Some(url::Host::Domain(name)) = url.host() {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            url.set_host(Some(&name)).ok()?;
        }
        Some(url)
    };
    let Some(url) = spelled(relay) else {
        return false;
    };
    let own: Vec<url::Url> = own.iter().filter_map(|mine| spelled(mine)).collect();
    if own.contains(&url) {
        return true;
    }
    // Another port or path at an own relay's name: that name resolves to whatever it answers (`relay_dns`).
    if own.iter().any(|mine| mine.host() == url.host()) {
        return false;
    }
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(name)) => {
            name.contains('.')
                && ![
                    "localhost",
                    "local",
                    "internal",
                    "lan",
                    "home",
                    "home.arpa",
                    "localdomain",
                    "intranet",
                    "corp",
                ]
                .iter()
                .any(|suffix| name == *suffix || name.ends_with(&format!(".{suffix}")))
        }
        Some(url::Host::Ipv4(ip)) => crate::link_preview::is_public(ip.into()),
        Some(url::Host::Ipv6(ip)) => crate::link_preview::is_public(ip.into()),
        None => false,
    }
}

/// The names an endpoint resolves (`system`'s answers), each held to where it may connect: a relay of its own (`own`,
/// either spelling) to whatever its name answers, as the person set it; any other name, a contact's relay above all, only
/// to public addresses. `dialable_relay` checks a contact's relay as written; this checks where its name leads each time
/// Iroh connects there, again on each redial, as a held item's address is (`hold_fetch.rs`, `PublicOnly`). A family
/// with any address that is not public is answered with none.
fn relay_dns(own: &[String], system: DnsResolver) -> DnsResolver {
    let own = own
        .iter()
        .filter_map(|relay| Some(host_name(url::Url::parse(relay).ok()?.host_str()?)))
        .collect();
    DnsResolver::custom(OwnOrPublic {
        system,
        own: Arc::new(own),
    })
}

/// A host name as compared here: lowercase, without the trailing dot of a full domain name.
fn host_name(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Debug, Clone)]
struct OwnOrPublic {
    system: DnsResolver,
    own: Arc<Vec<String>>,
}

/// How long one lookup waits for the system's resolver; Iroh bounds the whole call itself as well.
const LOOKUP_WAITS: Duration = Duration::from_secs(10);

type Lookup<T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<BoxIter<T>, DnsError>> + Send>>;

impl OwnOrPublic {
    fn checked<T: Into<std::net::IpAddr> + Copy + Send + 'static>(
        &self,
        host: &str,
        found: Vec<T>,
    ) -> BoxIter<T> {
        let mine = self.own.contains(&host_name(host));
        if mine
            || found
                .iter()
                .all(|ip| crate::link_preview::is_public((*ip).into()))
        {
            Box::new(found.into_iter())
        } else {
            crate::diagnostics::log(
                "iroh: a name that resolves to a non-public address is not connected to",
            );
            Box::new(std::iter::empty())
        }
    }
}

impl Resolver for OwnOrPublic {
    fn lookup_ipv4(&self, host: String) -> Lookup<std::net::Ipv4Addr> {
        let this = self.clone();
        Box::pin(async move {
            let found = this.system.lookup_ipv4(&host, LOOKUP_WAITS).await?;
            let found = found
                .filter_map(|ip| match ip {
                    std::net::IpAddr::V4(ip) => Some(ip),
                    std::net::IpAddr::V6(_) => None,
                })
                .collect();
            Ok(this.checked(&host, found))
        })
    }

    fn lookup_ipv6(&self, host: String) -> Lookup<std::net::Ipv6Addr> {
        let this = self.clone();
        Box::pin(async move {
            let found = this.system.lookup_ipv6(&host, LOOKUP_WAITS).await?;
            let found = found
                .filter_map(|ip| match ip {
                    std::net::IpAddr::V6(ip) => Some(ip),
                    std::net::IpAddr::V4(_) => None,
                })
                .collect();
            Ok(this.checked(&host, found))
        })
    }

    fn lookup_txt(&self, host: String) -> Lookup<TxtRecordData> {
        let system = self.system.clone();
        Box::pin(async move {
            let found: BoxIter<TxtRecordData> = Box::new(
                system
                    .lookup_txt(host, LOOKUP_WAITS)
                    .await?
                    .collect::<Vec<_>>()
                    .into_iter(),
            );
            Ok(found)
        })
    }

    fn clear_cache(&self) {
        self.system.clear_cache();
    }

    fn reset(&self) -> Box<dyn Resolver> {
        self.system.reset();
        Box::new(self.clone())
    }
}

#[tauri::command]
pub async fn paired_iroh_start(
    state: State<'_, TransportState>,
    seed_b64: String,
    relays: Option<Vec<String>>,
    events: Channel<Event>,
) -> Result<Started, String> {
    let seed: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(seed_b64)
        .map_err(|_| "Invalid transport seed")?
        .try_into()
        .map_err(|_| "Invalid transport seed")?;
    let env = std::env::var("GHOSTLY_IROH_RELAYS").ok();
    let relays = iroh_relays(relays, env.as_deref());
    state.start(seed, events, false, &relays).await
}
#[tauri::command]
pub async fn paired_iroh_address(
    state: State<'_, TransportState>,
    endpoint_id: u64,
) -> Result<wire::Address, String> {
    let inner = state.inner.lock().unwrap();
    Ok(wire::address(
        &inner
            .peers
            .get(&endpoint_id)
            .ok_or("Endpoint closed")?
            .endpoint,
    ))
}
#[tauri::command]
pub async fn paired_iroh_connect(
    state: State<'_, TransportState>,
    endpoint_id: u64,
    descriptor: wire::Address,
) -> Result<u64, String> {
    let (endpoint, events) = {
        let inner = state.inner.lock().unwrap();
        let peer = inner.peers.get(&endpoint_id).ok_or("Endpoint closed")?;
        if !dialable_relay(descriptor.relay.as_deref(), &peer.relays) {
            return Err("The contact's Iroh relay is not one this device dials".into());
        }
        (peer.endpoint.clone(), peer.events.clone())
    };
    let connection = wire::connect(&endpoint, &descriptor).await?;
    state
        .attach(endpoint_id, endpoint, connection, events, false)
        .await
}
/// One frame, answered once it is written on the stream: on a link slower than the page sends, it waits there for
/// room. So the page counts it against its send budget until then, and the engine sees the queue that is really
/// there (files and apps keep to their share of it). Only a closed connection is an error. The frame is `text`, or
/// `bytes`: a binary message (WISP 102 § Frames) in base64, as HyperDHT's (`paired_hyperdht_send`).
#[tauri::command]
pub async fn paired_native_send(
    state: State<'_, TransportState>,
    connection_id: u64,
    text: Option<String>,
    bytes: Option<String>,
) -> Result<(), String> {
    let (frame, binary) = match (text, bytes) {
        (Some(text), None) => (text.into_bytes(), false),
        (None, Some(bytes)) => (
            base64::engine::general_purpose::STANDARD
                .decode(bytes)
                .map_err(|_| "Invalid binary frame")?,
            true,
        ),
        _ => return Err("Invalid frame".into()),
    };
    if frame.is_empty() || frame.len() > wire::MAX_FRAME {
        return Err("Frame exceeds transport budget".into());
    }
    let tx = state
        .inner
        .lock()
        .unwrap()
        .sockets
        .get(&connection_id)
        .ok_or("Connection closed")?
        .1
        .tx
        .clone();
    let (written, done) = oneshot::channel();
    tx.send((frame, binary, written))
        .await
        .map_err(|_| "Connection closed")?;
    done.await.map_err(|_| "Connection closed".into())
}
/// The frame to send on this connection as the app exits (`TransportState::part`), in place of the one before; none
/// takes it back.
#[tauri::command]
pub fn paired_native_parting(
    state: State<'_, TransportState>,
    connection_id: u64,
    text: Option<String>,
) -> Result<(), String> {
    if text
        .as_ref()
        .is_some_and(|text| text.is_empty() || text.len() > wire::MAX_FRAME)
    {
        return Err("Frame exceeds transport budget".into());
    }
    let mut inner = state.inner.lock().unwrap();
    let (_, socket) = inner
        .sockets
        .get_mut(&connection_id)
        .ok_or("Connection closed")?;
    socket.parting = text;
    Ok(())
}
#[tauri::command]
pub fn paired_native_close(state: State<'_, TransportState>, connection_id: u64) {
    state.close(connection_id);
}
#[tauri::command]
pub async fn paired_iroh_stop(
    state: State<'_, TransportState>,
    endpoint_id: u64,
) -> Result<(), String> {
    let peer = {
        let mut inner = state.inner.lock().unwrap();
        let ids: Vec<_> = inner
            .sockets
            .iter()
            .filter(|(_, (p, _))| *p == endpoint_id)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some((_, socket)) = inner.sockets.remove(&id) {
                socket.connection.close(0u32.into(), b"endpoint stopped");
            }
        }
        inner.peers.remove(&endpoint_id)
    };
    if let Some(peer) = peer {
        peer.silence();
        peer.endpoint.close().await;
    }
    Ok(())
}

/// Two native peers on this machine's loopback: real QUIC, real handshakes,
/// the bridge's own bookkeeping.
#[cfg(test)]
mod tests {
    // covers: transport.iroh, transport.native-pool
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::AtomicBool;
    use tauri::ipc::InvokeResponseBody;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::Manager;

    type Seen = Arc<Mutex<Vec<Value>>>;

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(TransportState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    /// A channel that keeps what it is sent, as the UI would receive it.
    fn channel() -> (Channel<Event>, Seen) {
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                log.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, seen)
    }

    async fn start(app: &tauri::App<MockRuntime>, seed: u8) -> (u64, wire::Address, Seen) {
        let (events, seen) = channel();
        let started = app
            .state::<TransportState>()
            .start([seed; 32], events, true, &[])
            .await
            .unwrap();
        (started.id, started.descriptor, seen)
    }

    /// A contact names the relay it is dialled through: never this machine or its network, unless it is one of the
    /// endpoint's own relays.
    #[test]
    fn a_contact_is_dialled_through_a_public_relay_or_one_of_the_endpoints_own() {
        let none: [String; 0] = [];
        for relay in [
            "http://127.0.0.1:4601",
            "http://localhost:4601/",
            "http://[::1]:4601/",
            "https://10.0.0.1/",
            "https://[::1]/",
            "https://192.168.1.2/",
            "https://169.254.169.254/",
            "https://100.64.0.1/",
            "https://[fd00::1]/",
            "https://0x7f.1/",
            "https://localhost/",
            "https://router/",
            "https://nas.local./",
            "https://user@relay.test/",
            "https://relay.test/?x=1",
            "not a relay",
        ] {
            assert!(!dialable_relay(Some(relay), &none), "{relay}");
        }
        for relay in [
            None,
            Some("https://relay.test/"),
            Some("https://use1-1.relay.n0.iroh.link./"),
            Some("https://8.8.8.8/"),
        ] {
            assert!(dialable_relay(relay, &none), "{relay:?}");
        }
        let own = [
            "http://127.0.0.1:4600".to_string(),
            "https://10.0.0.1/".to_string(),
            "https://relay.lan.example./".to_string(),
        ];
        for relay in [
            "http://127.0.0.1:4600/",
            "https://10.0.0.1",
            "https://relay.lan.example/",
        ] {
            assert!(dialable_relay(Some(relay), &own), "{relay}");
        }
        for relay in [
            "http://127.0.0.1:4601/",
            "https://10.0.0.2/",
            "https://relay.lan.example:22/",
        ] {
            assert!(!dialable_relay(Some(relay), &own), "{relay}");
        }
    }

    /// A DNS that answers each name from a table, and nothing for any other: no lookup leaves this machine.
    #[derive(Debug)]
    struct Answers(Vec<(&'static str, std::net::IpAddr)>);
    impl Answers {
        fn of<T: Send + 'static>(
            &self,
            host: &str,
            pick: impl Fn(std::net::IpAddr) -> Option<T>,
        ) -> Lookup<T> {
            let found: Vec<T> = self
                .0
                .iter()
                .filter(|(name, _)| *name == host)
                .filter_map(|(_, ip)| pick(*ip))
                .collect();
            Box::pin(async move { Ok(Box::new(found.into_iter()) as BoxIter<T>) })
        }
    }
    impl Resolver for Answers {
        fn lookup_ipv4(&self, host: String) -> Lookup<std::net::Ipv4Addr> {
            self.of(&host, |ip| match ip {
                std::net::IpAddr::V4(ip) => Some(ip),
                _ => None,
            })
        }
        fn lookup_ipv6(&self, host: String) -> Lookup<std::net::Ipv6Addr> {
            self.of(&host, |ip| match ip {
                std::net::IpAddr::V6(ip) => Some(ip),
                _ => None,
            })
        }
        fn lookup_txt(&self, _host: String) -> Lookup<TxtRecordData> {
            Box::pin(async { Ok(Box::new(std::iter::empty()) as BoxIter<TxtRecordData>) })
        }
        fn clear_cache(&self) {}
        fn reset(&self) -> Box<dyn Resolver> {
            Box::new(Answers(self.0.clone()))
        }
    }

    /// A name a contact's relay is at resolves, for this endpoint, only to public addresses; an own relay's name to
    /// whatever it answers.
    #[tokio::test]
    async fn a_name_other_than_an_own_relays_resolves_only_to_public_addresses() {
        let ip = |text: &str| text.parse::<std::net::IpAddr>().unwrap();
        let system = DnsResolver::custom(Answers(vec![
            ("relay.contact.example", ip("127.0.0.1")),
            ("relay.contact.example", ip("::1")),
            ("lan.contact.example", ip("192.168.1.10")),
            ("mixed.contact.example", ip("8.8.8.8")),
            ("mixed.contact.example", ip("10.0.0.1")),
            ("public.contact.example", ip("8.8.8.8")),
            ("public.contact.example", ip("2001:4860:4860::8888")),
            ("relay.lan.example", ip("10.0.0.5")),
            ("Relay.Lan.Example.", ip("10.0.0.6")),
        ]));
        let dns = relay_dns(&["https://relay.lan.example./".to_string()], system);
        let wait = Duration::from_secs(1);
        let both = |host: &'static str| {
            let dns = dns.clone();
            async move {
                let mut found: Vec<std::net::IpAddr> =
                    dns.lookup_ipv4(host, wait).await.unwrap().collect();
                found.extend(dns.lookup_ipv6(host, wait).await.unwrap());
                found
            }
        };
        for host in [
            "relay.contact.example",
            "lan.contact.example",
            "mixed.contact.example",
        ] {
            assert_eq!(both(host).await, Vec::<std::net::IpAddr>::new(), "{host}");
        }
        assert_eq!(
            both("public.contact.example").await,
            vec![ip("8.8.8.8"), ip("2001:4860:4860::8888")]
        );
        assert_eq!(both("relay.lan.example").await, vec![ip("10.0.0.5")]);
        assert_eq!(both("Relay.Lan.Example.").await, vec![ip("10.0.0.6")]);
    }

    /// A contact names a relay at a public name whose DNS answers this machine: the endpoint never connects there, on
    /// the first dial or a redial. A local TCP service counts what reaches it; the same dial with the system's answers
    /// taken as they are does reach it, so the count would see one.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_contacts_relay_whose_name_resolves_to_this_machine_is_not_connected_to() {
        let service = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = service.local_addr().unwrap().port();
        let reached = Arc::new(AtomicU64::new(0));
        let count = reached.clone();
        let serving = tokio::spawn(async move {
            while let Ok((socket, _)) = service.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        // The endpoint's own relay: one on this machine that nobody runs.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let own = vec![format!(
            "http://127.0.0.1:{}/",
            dead.local_addr().unwrap().port()
        )];
        drop(dead);
        let answers = || {
            DnsResolver::custom(Answers(vec![(
                "relay.contact.example",
                "127.0.0.1".parse().unwrap(),
            )]))
        };
        let contact = wire::Address {
            id: iroh::SecretKey::from_bytes(&[52; 32]).public().to_string(),
            relay: Some(format!("https://relay.contact.example:{port}/")),
            addresses: vec![],
        };
        assert!(dialable_relay(contact.relay.as_deref(), &own));
        let dial = |dns: DnsResolver, seed: u8| {
            let (own, contact) = (own.clone(), contact.clone());
            async move {
                let endpoint = wire::endpoint_with_relays([seed; 32], &own, Some(dns))
                    .await
                    .unwrap();
                for _ in 0..2 {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(3),
                        wire::connect(&endpoint, &contact),
                    )
                    .await;
                }
                endpoint.close().await;
            }
        };
        dial(relay_dns(&own, answers()), 50).await;
        assert_eq!(
            reached.load(Ordering::SeqCst),
            0,
            "connected to this machine"
        );
        dial(answers(), 51).await;
        assert!(
            reached.load(Ordering::SeqCst) > 0,
            "the dial is seen when it happens"
        );
        serving.abort();
    }

    #[test]
    fn iroh_relays_are_the_persons_then_the_environment_then_none() {
        let mine = Some(vec![
            " https://iroh.person.test/ ".to_string(),
            "".to_string(),
        ]);
        assert_eq!(
            iroh_relays(mine, Some("https://iroh.env.test/")),
            vec!["https://iroh.person.test/"]
        );
        assert_eq!(
            iroh_relays(Some(vec![]), Some(" https://a.test/ , ,https://b.test/")),
            vec!["https://a.test/", "https://b.test/"]
        );
        assert_eq!(iroh_relays(None, Some("  ")), Vec::<String>::new());
        assert_eq!(iroh_relays(None, None), Vec::<String>::new());
    }

    #[tokio::test]
    async fn an_endpoint_takes_one_to_five_relays_of_its_own() {
        let app = app();
        let (events, _) = channel();
        // Five is the browser build's limit too: n0's four plus Ghostly's own fit.
        let six: Vec<String> = (0..6).map(|i| format!("https://r{i}.test/")).collect();
        let refused = app
            .state::<TransportState>()
            .start([21; 32], events.clone(), false, &six)
            .await;
        assert!(refused.is_err(), "more than five relays are refused");
        // One relay that nobody runs: the endpoint binds all the same, and homes there when it answers.
        app.state::<TransportState>()
            .start(
                [21; 32],
                events,
                false,
                &["http://127.0.0.1:9/".to_string()],
            )
            .await
            .unwrap();
        app.state::<TransportState>()
            .shutdown(Duration::from_secs(2))
            .await;
    }

    /// Waits until `seen` holds an event matching `wanted`, and returns it.
    async fn event(seen: &Seen, wanted: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            if let Some(found) = seen.lock().unwrap().iter().find(|e| wanted(e)) {
                return found.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no such event in {:?}", seen.lock().unwrap());
    }

    fn kind<'a>(kind: &'a str) -> impl Fn(&Value) -> bool + 'a {
        move |e| e["type"] == kind
    }

    async fn connect(
        app: &tauri::App<MockRuntime>,
        from: u64,
        to: &wire::Address,
    ) -> Result<u64, String> {
        paired_iroh_connect(app.state(), from, to.clone()).await
    }

    /// The page is told an address that came to be another, once it settled, and only then: it never has to ask.
    #[tokio::test(start_paused = true)]
    async fn the_page_is_told_each_address_the_endpoint_comes_to_have_once() {
        let address = |relay: Option<&str>, addresses: &[&str]| wire::Address {
            id: "ab".repeat(32),
            relay: relay.map(String::from),
            addresses: addresses.iter().map(|a| a.to_string()).collect(),
        };
        let first = address(None, &["192.168.1.5:4433"]);
        let now = Arc::new(Mutex::new(first.clone()));
        let (changed, changes) = mpsc::unbounded_channel::<()>();
        let (events, seen) = channel();
        let read = now.clone();
        let telling = tokio::spawn(tell_address(
            tokio_stream(changes),
            move || read.lock().unwrap().clone(),
            first,
            events,
        ));
        let told = || seen.lock().unwrap().clone();

        // Something moved that left the address as it was said: nothing.
        changed.send(()).unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(told().is_empty(), "{:?}", told());

        // It homed on a relay, then a direct address came 200 ms later: one word, with both.
        *now.lock().unwrap() = address(Some("https://relay.test./"), &["192.168.1.5:4433"]);
        changed.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let settled = address(
            Some("https://relay.test./"),
            &["192.168.1.5:4433", "203.0.113.7:4433"],
        );
        *now.lock().unwrap() = settled.clone();
        changed.send(()).unwrap();
        assert!(told().is_empty(), "told before it settled");
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(
            told(),
            vec![serde_json::json!({"type": "address", "descriptor": settled})]
        );

        // Nothing moves for an hour: nothing is said, and nothing is asked.
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert_eq!(told().len(), 1);

        // The endpoint is gone (Iroh's watcher ends): so is the telling.
        drop(changed);
        telling.await.unwrap();
    }

    fn tokio_stream<T>(mut changes: mpsc::UnboundedReceiver<T>) -> impl Stream<Item = T> + Unpin {
        futures_util::stream::poll_fn(move |cx| changes.poll_recv(cx))
    }

    /// An Android phone back from Doze: its Iroh lost its relay while the network was cut and finds it again seconds after
    /// the return. The page is told then, once, and a chat whose knock is still under way knocks again (ghostlink.ts).
    #[tokio::test]
    async fn the_page_is_told_when_the_endpoint_is_back_on_its_relay() {
        let (status, statuses) = mpsc::unbounded_channel::<bool>();
        let (events, seen) = channel();
        let telling = tokio::spawn(tell_relay_back(tokio_stream(statuses), true, events));
        let told = || async {
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
            seen.lock().unwrap().clone()
        };
        // Still on it, then lost, and still lost: nothing.
        for connected in [true, false, false] {
            status.send(connected).unwrap();
        }
        assert!(told().await.is_empty());
        // Back: one word; still on it: nothing more.
        status.send(true).unwrap();
        status.send(true).unwrap();
        assert_eq!(told().await, vec![serde_json::json!({"type": "relayBack"})]);
        // Lost and back once more: a second word.
        status.send(false).unwrap();
        status.send(true).unwrap();
        assert_eq!(told().await.len(), 2);
        drop(status);
        telling.await.unwrap();
    }

    /// An endpoint that homes on its relay for the first time is not back on it: nothing is said.
    #[tokio::test]
    async fn an_endpoint_homing_first_is_not_back_on_its_relay() {
        let (status, statuses) = mpsc::unbounded_channel::<bool>();
        let (events, seen) = channel();
        let telling = tokio::spawn(tell_relay_back(tokio_stream(statuses), false, events));
        for connected in [false, true, true] {
            status.send(connected).unwrap();
        }
        drop(status);
        telling.await.unwrap();
        assert!(seen.lock().unwrap().is_empty());
    }

    /// A real endpoint is watched from its start, and no longer once it is stopped.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_endpoint_is_watched_until_it_is_stopped() {
        let app = app();
        let (alice, _, _) = start(&app, 50).await;
        let watcher = {
            let state = app.state::<TransportState>();
            let inner = state.inner.lock().unwrap();
            inner.peers[&alice].watcher.abort_handle()
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!watcher.is_finished());
        paired_iroh_stop(app.state(), alice).await.unwrap();
        for _ in 0..200 {
            if watcher.is_finished() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the watcher outlived its endpoint");
    }

    #[tokio::test]
    async fn a_seed_is_32_bytes_of_base64url() {
        let app = app();
        for seed in ["", "not base64!", "AAAA", &"A".repeat(44)] {
            let (events, _) = channel();
            assert_eq!(
                paired_iroh_start(app.state(), seed.into(), None, events)
                    .await
                    .err()
                    .unwrap(),
                "Invalid transport seed"
            );
        }
    }

    /// Android's network callback reaches every endpoint, and a live connection goes on through it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_network_change_reaches_every_endpoint_and_keeps_its_connections() {
        let (one, other) = (app(), app());
        let state = one.state::<TransportState>();
        assert_eq!(state.network_changed().await, 0, "no endpoint yet");
        let (alice, _, alice_seen) = start(&one, 5).await;
        start(&one, 6).await;
        let (_bob, bob_address, bob_seen) = start(&other, 7).await;
        let sent = connect(&one, alice, &bob_address).await.unwrap();
        event(&bob_seen, kind("open")).await;

        assert_eq!(state.network_changed().await, 2);
        paired_native_send(one.state(), sent, Some("after the change".into()), None)
            .await
            .unwrap();
        let frame = event(&bob_seen, kind("frame")).await;
        assert_eq!(frame["text"], "after the change");
        assert!(!alice_seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "closed"));
        for app in [&one, &other] {
            app.state::<TransportState>()
                .shutdown(Duration::from_secs(2))
                .await;
        }
    }

    /// An app exiting closes what it has: the contact's app sees its connection closed at once,
    /// not after QUIC's 30 s idle timeout, and watches for this app to come back.
    #[tokio::test(flavor = "multi_thread")]
    async fn exiting_closes_every_connection_so_the_contact_hears_it_at_once() {
        let (leaving, staying) = (app(), app());
        let (alice, _, _) = start(&leaving, 3).await;
        let (_bob, bob_address, bob_seen) = start(&staying, 4).await;
        connect(&leaving, alice, &bob_address).await.unwrap();
        let accepted = event(&bob_seen, kind("open")).await["id"].clone();

        let started = std::time::Instant::now();
        leaving
            .state::<TransportState>()
            .shutdown(Duration::from_secs(2))
            .await;
        let closed = event(&bob_seen, kind("closed")).await;
        assert_eq!(closed["id"], accepted);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        // Nothing is left to dial or be dialled on.
        assert!(leaving
            .state::<TransportState>()
            .inner
            .lock()
            .unwrap()
            .peers
            .is_empty());
    }

    /// The page left a call's hang-up for its exit and is gone by then (a logout): the app says it on the connection,
    /// once, before the close. One taken back is not said; a connection that has none says nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn exiting_says_what_the_page_left_to_be_said_before_the_close() {
        let (leaving, staying) = (app(), app());
        let (alice, _, _) = start(&leaving, 5).await;
        let (_bob, bob_address, bob_seen) = start(&staying, 6).await;
        let (_carol, carol_address, carol_seen) = start(&staying, 7).await;
        let to_bob = connect(&leaving, alice, &bob_address).await.unwrap();
        let to_carol = connect(&leaving, alice, &carol_address).await.unwrap();
        let from_alice = event(&bob_seen, kind("open")).await["id"].clone();
        event(&carol_seen, kind("open")).await;

        let hang_up = r#"{"t":"paired-call","s":"{\"t\":\"h\",\"ts\":1700000000001}"}"#;
        for text in [String::new(), "x".repeat(wire::MAX_FRAME + 1)] {
            assert_eq!(
                paired_native_parting(leaving.state(), to_bob, Some(text)).unwrap_err(),
                "Frame exceeds transport budget"
            );
        }
        assert_eq!(
            paired_native_parting(leaving.state(), 999, Some(hang_up.into())).unwrap_err(),
            "Connection closed"
        );
        paired_native_parting(leaving.state(), to_bob, Some("an older one".into())).unwrap();
        paired_native_parting(leaving.state(), to_bob, Some(hang_up.into())).unwrap();
        paired_native_parting(leaving.state(), to_carol, Some(hang_up.into())).unwrap();
        paired_native_parting(leaving.state(), to_carol, None).unwrap();
        paired_native_send(leaving.state(), to_bob, Some("sent before".into()), None)
            .await
            .unwrap();

        // As the app goes: told when its exit is held for the page's goodbye, closed `DEPART_MS` later.
        let state = leaving.state::<TransportState>();
        state.part().await;
        state.part().await;
        event(&bob_seen, |e| e["text"] == hang_up).await;
        state.shutdown(Duration::from_secs(2)).await;
        event(&bob_seen, kind("closed")).await;
        let frames: Vec<Value> = bob_seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "frame")
            .cloned()
            .collect();
        assert_eq!(
            frames,
            vec![
                serde_json::json!({"type": "frame", "id": from_alice, "text": "sent before"}),
                serde_json::json!({"type": "frame", "id": from_alice, "text": hang_up}),
            ]
        );
        event(&carol_seen, kind("closed")).await;
        assert!(!carol_seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "frame"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn frames_travel_both_ways_over_a_connection_bound_to_its_handshake() {
        let app = app();
        let (alice, _, alice_seen) = start(&app, 1).await;
        let (_bob, bob_address, bob_seen) = start(&app, 2).await;
        let outgoing = connect(&app, alice, &bob_address).await.unwrap();

        let opened = event(&alice_seen, kind("open")).await;
        assert_eq!(
            (opened["id"].as_u64(), &opened["incoming"]),
            (Some(outgoing), &Value::Bool(false))
        );
        let accepted = event(&bob_seen, kind("open")).await;
        assert_eq!(accepted["incoming"], true);
        assert_eq!(accepted["binding"]["transport"], "iroh/1");
        assert_eq!(
            accepted["binding"], opened["binding"],
            "both ends see one handshake"
        );
        let incoming = accepted["id"].as_u64().unwrap();

        paired_native_send(app.state(), outgoing, Some("hello bob".into()), None)
            .await
            .unwrap();
        let frame = event(&bob_seen, kind("frame")).await;
        assert_eq!(
            (frame["id"].as_u64(), frame["text"].as_str()),
            (Some(incoming), Some("hello bob"))
        );
        let largest = "x".repeat(wire::MAX_FRAME);
        paired_native_send(app.state(), incoming, Some(largest.clone()), None)
            .await
            .unwrap();
        let frame = event(&alice_seen, kind("frame")).await;
        assert_eq!(frame["text"].as_str().map(str::len), Some(wire::MAX_FRAME));
    }

    /// A binary message (WISP 102 § Frames: a file's bytes where the session agreed `files/4`) crosses as bytes, in
    /// base64 between the page and Rust as HyperDHT's, up to a text frame's budget, and a text after it is still text.
    #[tokio::test(flavor = "multi_thread")]
    async fn binary_messages_travel_both_ways_beside_text() {
        let app = app();
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let (alice, _, alice_seen) = start(&app, 64).await;
        let (_bob, bob_address, bob_seen) = start(&app, 65).await;
        let outgoing = connect(&app, alice, &bob_address).await.unwrap();
        let incoming = event(&bob_seen, kind("open")).await["id"].as_u64().unwrap();

        // Not UTF-8: as text, this closed the connection ("Non-text paired frame").
        let bytes = [0u8, 0xff, 0xfe, 0x80];
        paired_native_send(app.state(), outgoing, None, Some(encode(&bytes)))
            .await
            .unwrap();
        paired_native_send(app.state(), outgoing, Some("after the bytes".into()), None)
            .await
            .unwrap();
        let frame = event(&bob_seen, kind("frame")).await;
        assert_eq!(
            (
                frame["id"].as_u64(),
                frame["bytes"].as_str(),
                frame.get("text")
            ),
            (Some(incoming), Some(encode(&bytes).as_str()), None)
        );
        event(&bob_seen, |e| e["text"] == "after the bytes").await;

        let largest = vec![0xffu8; wire::MAX_FRAME];
        paired_native_send(app.state(), incoming, None, Some(encode(&largest)))
            .await
            .unwrap();
        let frame = event(&alice_seen, kind("frame")).await;
        assert_eq!(frame["bytes"].as_str(), Some(encode(&largest).as_str()));
        assert!(!bob_seen
            .lock()
            .unwrap()
            .iter()
            .chain(alice_seen.lock().unwrap().iter())
            .any(|e| e["type"] == "closed"));
    }

    /// A channel whose page takes no frame while `stalled` holds: a contact on a link slower than this side writes.
    fn slow_channel(stalled: Arc<AtomicBool>) -> (Channel<Event>, Seen) {
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let event: Value = serde_json::from_str(&json).unwrap();
                while event["type"] == "frame" && stalled.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(10));
                }
                log.lock().unwrap().push(event);
            }
            Ok(())
        });
        (channel, seen)
    }

    async fn send(
        app: &tauri::AppHandle<MockRuntime>,
        id: u64,
        text: String,
    ) -> Result<(), String> {
        paired_native_send(app.state(), id, Some(text), None).await
    }

    /// An app sending at its full rate over a link slower than that: each frame waits for room on the stream, in
    /// order, so the page counts it against its budget until it is written. None is refused for a full queue, which
    /// the page took for a dead connection and closed, taking the chat's session down with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_frame_waits_for_room_on_the_stream_and_is_counted_until_written() {
        let app = app();
        let (alice, _, alice_seen) = start(&app, 60).await;
        let stalled = Arc::new(AtomicBool::new(true));
        let (events, bob_seen) = slow_channel(stalled.clone());
        let bob = app
            .state::<TransportState>()
            .start([61; 32], events, true, &[])
            .await
            .unwrap();
        let outgoing = connect(&app, alice, &bob.descriptor).await.unwrap();
        event(&bob_seen, kind("open")).await;

        let frames = 256;
        let handle = app.handle().clone();
        let sending = tokio::spawn(async move {
            for i in 0..frames {
                let text = format!("{i:05}{}", "x".repeat(wire::MAX_FRAME - 5));
                send(&handle, outgoing, text).await?;
            }
            Ok::<(), String>(())
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        let waiting = !sending.is_finished();
        stalled.store(false, Ordering::SeqCst);
        let sent = sending.await.unwrap();
        assert!(
            waiting,
            "a frame with no room on the stream waits: {sent:?}"
        );
        sent.unwrap();
        for _ in 0..400 {
            if bob_seen
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["type"] == "frame")
                .count()
                == frames
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let order: Vec<String> = bob_seen
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "frame")
            .map(|e| e["text"].as_str().unwrap()[..5].to_string())
            .collect();
        assert_eq!(
            order,
            (0..frames).map(|i| format!("{i:05}")).collect::<Vec<_>>()
        );
        assert!(!alice_seen
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "closed"));
    }

    #[tokio::test]
    async fn refuses_frames_out_of_budget_and_unknown_connections() {
        let app = app();
        assert_eq!(
            paired_native_send(app.state(), 1, Some(String::new()), None)
                .await
                .unwrap_err(),
            "Frame exceeds transport budget"
        );
        assert_eq!(
            paired_native_send(app.state(), 1, Some("x".repeat(wire::MAX_FRAME + 1)), None)
                .await
                .unwrap_err(),
            "Frame exceeds transport budget"
        );
        assert_eq!(
            paired_native_send(app.state(), 1, Some("x".into()), None)
                .await
                .unwrap_err(),
            "Connection closed"
        );
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        for (text, bytes, error) in [
            (None, None, "Invalid frame"),
            (Some("x".to_string()), Some(encode(b"x")), "Invalid frame"),
            (
                None,
                Some("not base64!".to_string()),
                "Invalid binary frame",
            ),
            (None, Some(String::new()), "Frame exceeds transport budget"),
            (
                None,
                Some(encode(&vec![0; wire::MAX_FRAME + 1])),
                "Frame exceeds transport budget",
            ),
            (None, Some(encode(b"x")), "Connection closed"),
        ] {
            assert_eq!(
                paired_native_send(app.state(), 1, text, bytes)
                    .await
                    .unwrap_err(),
                error
            );
        }
        assert_eq!(
            paired_iroh_address(app.state(), 1).await.unwrap_err(),
            "Endpoint closed"
        );
        let (_, somewhere, _) = start(&app, 3).await;
        assert_eq!(
            connect(&app, 999, &somewhere).await.unwrap_err(),
            "Endpoint closed"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_tells_the_other_end_and_a_reconnect_is_a_new_handshake() {
        let app = app();
        let (alice, _, _) = start(&app, 4).await;
        let (_, bob_address, bob_seen) = start(&app, 5).await;
        let first = connect(&app, alice, &bob_address).await.unwrap();
        let first_binding = event(&bob_seen, kind("open")).await["binding"].clone();
        let bob_first = event(&bob_seen, kind("open")).await["id"].as_u64().unwrap();

        paired_native_close(app.state(), first);
        event(&bob_seen, |e| {
            e["type"] == "closed" && e["id"].as_u64() == Some(bob_first)
        })
        .await;
        assert_eq!(
            paired_native_send(app.state(), first, Some("late".into()), None)
                .await
                .unwrap_err(),
            "Connection closed"
        );

        let second = connect(&app, alice, &bob_address).await.unwrap();
        assert_ne!(first, second);
        let reopened = event(&bob_seen, |e| {
            e["type"] == "open" && e["id"].as_u64() != Some(bob_first)
        })
        .await;
        assert_ne!(reopened["binding"]["context"], first_binding["context"]);
        paired_native_send(app.state(), second, Some("again".into()), None)
            .await
            .unwrap();
        event(&bob_seen, |e| e["text"] == "again").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_connections_per_endpoint_and_eight_endpoints_at_most() {
        let app = app();
        let (alice, _, _) = start(&app, 6).await;
        let (_, bob_address, _) = start(&app, 7).await;
        connect(&app, alice, &bob_address).await.unwrap();
        connect(&app, alice, &bob_address).await.unwrap();
        assert_eq!(
            connect(&app, alice, &bob_address).await.unwrap_err(),
            "Native connection limit reached"
        );

        for seed in 10..16 {
            start(&app, seed).await;
        }
        let (events, _) = channel();
        let ninth = app
            .state::<TransportState>()
            .start([20; 32], events, true, &[])
            .await;
        assert_eq!(ninth.err().unwrap(), "Native endpoint limit reached");
        // The command refuses too, before binding anything.
        let (events, _) = channel();
        let seed = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([21u8; 32]);
        assert_eq!(
            paired_iroh_start(app.state(), seed, None, events)
                .await
                .err()
                .unwrap(),
            "Native endpoint limit reached"
        );
    }

    /// A page that starts (loaded again, or back after its process died) finds its eight places free: what the
    /// page before it left running is stopped, and a contact on the other end hears the close at once.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_that_starts_frees_what_the_page_before_it_left_running() {
        let (page, contact) = (app(), app());
        let mut left = Vec::new();
        for seed in 30..38 {
            left.push(start(&page, seed).await.0);
        }
        let (_bob, bob_address, bob_seen) = start(&contact, 40).await;
        connect(&page, left[0], &bob_address).await.unwrap();
        let accepted = event(&bob_seen, kind("open")).await["id"].clone();
        let (events, _) = channel();
        let ninth = page
            .state::<TransportState>()
            .start([41; 32], events, true, &[])
            .await;
        assert_eq!(ninth.err().unwrap(), "Native endpoint limit reached");

        page.state::<TransportState>().page_started();

        assert_eq!(event(&bob_seen, kind("closed")).await["id"], accepted);
        for id in left {
            assert_eq!(
                paired_iroh_address(page.state(), id).await.unwrap_err(),
                "Endpoint closed"
            );
        }
        for seed in 50..58 {
            start(&page, seed).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_an_endpoint_closes_its_connections() {
        let app = app();
        let (alice, _, _) = start(&app, 30).await;
        let (_, bob_address, bob_seen) = start(&app, 31).await;
        connect(&app, alice, &bob_address).await.unwrap();
        connect(&app, alice, &bob_address).await.unwrap();
        let count = |kind: &str| {
            bob_seen
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["type"] == kind)
                .count()
        };
        // Both streams reached Bob before Alice stops.
        for _ in 0..200 {
            if count("open") == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(count("open"), 2);
        paired_iroh_stop(app.state(), alice).await.unwrap();
        for _ in 0..200 {
            if count("closed") == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(count("closed"), 2);
        assert_eq!(
            paired_iroh_address(app.state(), alice).await.unwrap_err(),
            "Endpoint closed"
        );
        assert!(app
            .state::<TransportState>()
            .inner
            .lock()
            .unwrap()
            .sockets
            .values()
            .all(|(p, _)| *p != alice));
        // Stopping what is gone is fine.
        paired_iroh_stop(app.state(), alice).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_peer_must_speak_the_protocol() {
        let app = app();
        let (_, bob_address, bob_seen) = start(&app, 40).await;
        let stranger = wire::endpoint([41; 32], true, None).await.unwrap();

        // Without the preface, the stream is never offered to the UI.
        let rude = wire::connect(&stranger, &bob_address).await.unwrap();
        let (mut send, _recv) = rude.open_bi().await.unwrap();
        wire::write_frame(&mut send, b"ghostly/something-else/1")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            bob_seen.lock().unwrap().is_empty(),
            "{:?}",
            bob_seen.lock().unwrap()
        );

        // With it, but then bytes that are not text: the connection closes.
        let polite = wire::connect(&stranger, &bob_address).await.unwrap();
        let (mut send, _recv) = polite.open_bi().await.unwrap();
        wire::write_frame(&mut send, ALPN_PREFACE).await.unwrap();
        let opened = event(&bob_seen, kind("open")).await;
        wire::write_frame(&mut send, &[0xff, 0xfe]).await.unwrap();
        event(&bob_seen, |e| {
            e["type"] == "closed" && e["id"] == opened["id"]
        })
        .await;

        // Or a length past the budget, before any payload.
        let greedy = wire::connect(&stranger, &bob_address).await.unwrap();
        let (mut send, _recv) = greedy.open_bi().await.unwrap();
        wire::write_frame(&mut send, ALPN_PREFACE).await.unwrap();
        let opened = event(&bob_seen, |e| {
            e["type"] == "open" && e["id"] != opened["id"]
        })
        .await;
        send.write_all(&((wire::MAX_FRAME as u32 + 1).to_be_bytes()))
            .await
            .unwrap();
        event(&bob_seen, |e| {
            e["type"] == "closed" && e["id"] == opened["id"]
        })
        .await;
        stranger.close().await;
    }

    const ALPN_PREFACE: &[u8] = b"ghostly/paired-chat/1";
}
