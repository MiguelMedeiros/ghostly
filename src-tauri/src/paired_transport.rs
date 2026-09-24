//! Bounded, main-window-only bridge for native paired channels. No application
//! identities or receipts live here: those remain in the shared paired engine.
use base64::Engine;
use ghostly_transports::iroh_transport as wire;
use iroh::{endpoint::Connection, Endpoint};
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
use tokio::sync::mpsc;

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
    Closed {
        id: u64,
    },
}
struct Socket {
    connection: Connection,
    tx: mpsc::Sender<String>,
}
struct Peer {
    endpoint: Endpoint,
    events: Channel<Event>,
    listener: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
struct Inner {
    peers: HashMap<u64, Peer>,
    sockets: HashMap<u64, (u64, Socket)>,
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
        let (tx, mut rx) = mpsc::channel::<String>(32);
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
                _ = async { while let Some(text) = rx.recv().await { wire::write_frame(&mut send, text.as_bytes()).await?; } Ok::<(), String>(()) } => {},
                _ = async { loop { let frame = wire::read_frame(&mut recv).await?; let text = String::from_utf8(frame).map_err(|_| "Non-text paired frame")?; events.send(Event::Frame { id, text }).map_err(|_| "Native UI unavailable")?; } #[allow(unreachable_code)] Ok::<(), String>(()) } => {},
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
    /// Binds an endpoint for `seed` and accepts on it. `local_only` keeps it on
    /// this machine's loopback, with no relay (tests).
    async fn start(
        &self,
        seed: [u8; 32],
        events: Channel<Event>,
        local_only: bool,
    ) -> Result<Started, String> {
        if self.inner.lock().unwrap().peers.len() >= 8 {
            return Err("Native endpoint limit reached".into());
        }
        let endpoint = wire::endpoint(seed, local_only).await?;
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
        if inner.peers.len() >= 8 {
            listener.abort();
            return Err("Native endpoint limit reached".into());
        }
        inner.peers.insert(
            id,
            Peer {
                endpoint,
                events,
                listener,
            },
        );
        Ok(Started { id, descriptor })
    }
}

#[tauri::command]
pub async fn paired_iroh_start(
    state: State<'_, TransportState>,
    seed_b64: String,
    events: Channel<Event>,
) -> Result<Started, String> {
    let seed: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(seed_b64)
        .map_err(|_| "Invalid transport seed")?
        .try_into()
        .map_err(|_| "Invalid transport seed")?;
    state.start(seed, events, false).await
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
        (peer.endpoint.clone(), peer.events.clone())
    };
    let connection = wire::connect(&endpoint, &descriptor).await?;
    state
        .attach(endpoint_id, endpoint, connection, events, false)
        .await
}
#[tauri::command]
pub fn paired_native_send(
    state: State<'_, TransportState>,
    connection_id: u64,
    text: String,
) -> Result<(), String> {
    if text.is_empty() || text.len() > wire::MAX_FRAME {
        return Err("Frame exceeds transport budget".into());
    }
    let inner = state.inner.lock().unwrap();
    inner
        .sockets
        .get(&connection_id)
        .ok_or("Connection closed")?
        .1
        .tx
        .try_send(text)
        .map_err(|_| "Native send queue full or closed".into())
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
        peer.listener.abort();
        peer.endpoint.close().await;
    }
    Ok(())
}

/// Two native peers on this machine's loopback: real QUIC, real handshakes,
/// the bridge's own bookkeeping.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
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
            .start([seed; 32], events, true)
            .await
            .unwrap();
        (started.id, started.descriptor, seen)
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

    #[tokio::test]
    async fn a_seed_is_32_bytes_of_base64url() {
        let app = app();
        for seed in ["", "not base64!", "AAAA", &"A".repeat(44)] {
            let (events, _) = channel();
            assert_eq!(
                paired_iroh_start(app.state(), seed.into(), events)
                    .await
                    .err()
                    .unwrap(),
                "Invalid transport seed"
            );
        }
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

        paired_native_send(app.state(), outgoing, "hello bob".into()).unwrap();
        let frame = event(&bob_seen, kind("frame")).await;
        assert_eq!(
            (frame["id"].as_u64(), frame["text"].as_str()),
            (Some(incoming), Some("hello bob"))
        );
        let largest = "x".repeat(wire::MAX_FRAME);
        paired_native_send(app.state(), incoming, largest.clone()).unwrap();
        let frame = event(&alice_seen, kind("frame")).await;
        assert_eq!(frame["text"].as_str().map(str::len), Some(wire::MAX_FRAME));
    }

    #[tokio::test]
    async fn refuses_frames_out_of_budget_and_unknown_connections() {
        let app = app();
        assert_eq!(
            paired_native_send(app.state(), 1, String::new()).unwrap_err(),
            "Frame exceeds transport budget"
        );
        assert_eq!(
            paired_native_send(app.state(), 1, "x".repeat(wire::MAX_FRAME + 1)).unwrap_err(),
            "Frame exceeds transport budget"
        );
        assert_eq!(
            paired_native_send(app.state(), 1, "x".into()).unwrap_err(),
            "Connection closed"
        );
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
        let (alice, _, alice_seen) = start(&app, 4).await;
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
            paired_native_send(app.state(), first, "late".into()).unwrap_err(),
            "Connection closed"
        );

        let second = connect(&app, alice, &bob_address).await.unwrap();
        assert_ne!(first, second);
        let reopened = event(&bob_seen, |e| {
            e["type"] == "open" && e["id"].as_u64() != Some(bob_first)
        })
        .await;
        assert_ne!(reopened["binding"]["context"], first_binding["context"]);
        paired_native_send(app.state(), second, "again".into()).unwrap();
        event(&bob_seen, |e| e["text"] == "again").await;
        drop(alice_seen);
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
            .start([20; 32], events, true)
            .await;
        assert_eq!(ninth.err().unwrap(), "Native endpoint limit reached");
        // The command refuses too, before binding anything.
        let (events, _) = channel();
        let seed = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([21u8; 32]);
        assert_eq!(
            paired_iroh_start(app.state(), seed, events)
                .await
                .err()
                .unwrap(),
            "Native endpoint limit reached"
        );
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
        let stranger = wire::endpoint([41; 32], true).await.unwrap();

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
