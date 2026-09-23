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
    if state.inner.lock().unwrap().peers.len() >= 8 {
        return Err("Native endpoint limit reached".into());
    }
    let endpoint = wire::endpoint(seed, false).await?;
    let id = state.next();
    let descriptor = wire::address(&endpoint);
    let listener_endpoint = endpoint.clone();
    let listener_state = state.inner().clone();
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
    let mut inner = state.inner.lock().unwrap();
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
