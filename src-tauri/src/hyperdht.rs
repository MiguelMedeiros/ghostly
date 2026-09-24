//! Fixed packaged HyperDHT runtime, controlled over private pipes. This bridge
//! cannot launch arbitrary programs or expose a network administration port.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};

type Reply = oneshot::Sender<Result<Value, String>>;
struct Request {
    value: Value,
    reply: Option<Reply>,
}
struct Peer {
    tx: mpsc::Sender<Request>,
    descriptor: Value,
}
#[derive(Clone, Default)]
pub struct HyperState {
    peers: Arc<Mutex<HashMap<u64, Peer>>>,
    next: Arc<AtomicU64>,
}
#[derive(Serialize)]
pub struct Started {
    id: u64,
    descriptor: Value,
}

#[tauri::command]
pub async fn paired_hyperdht_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, HyperState>,
    seed_b64: String,
    events: Channel<Value>,
) -> Result<Started, String> {
    use base64::Engine;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&seed_b64)
        .map_err(|_| "Invalid transport seed")?
        .len()
        != 32
    {
        return Err("Invalid transport seed".into());
    }
    if state.peers.lock().unwrap().len() >= 8 {
        return Err("Native endpoint limit reached".into());
    }
    let mut root = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("native-runtime");
    #[cfg(debug_assertions)]
    if !root.join("sidecar.mjs").exists() {
        root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("native-runtime");
    }
    let executable = root.join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut child = Command::new(executable)
        .arg(root.join("sidecar.mjs"))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Packaged HyperDHT runtime unavailable: {e}"))?;
    let mut input = child.stdin.take().ok_or("Native stdin unavailable")?;
    let mut output =
        BufReader::new(child.stdout.take().ok_or("Native stdout unavailable")?).lines();
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::channel::<Request>(32);
    let (ready_tx, ready_rx) = oneshot::channel();
    {
        let mut peers = state.peers.lock().unwrap();
        if peers.len() >= 8 {
            return Err("Native endpoint limit reached".into());
        }
        peers.insert(
            id,
            Peer {
                tx,
                descriptor: Value::Null,
            },
        );
    }
    let peers = state.peers.clone();
    tokio::spawn(async move {
        let mut ready = Some(ready_tx);
        let mut pending: Option<Reply> = None;
        let mut sockets = Vec::<u64>::new();
        let init = json!({"type":"start", "seedB64":seed_b64}).to_string() + "\n";
        if input.write_all(init.as_bytes()).await.is_err() {
            peers.lock().unwrap().remove(&id);
            return;
        }
        loop {
            tokio::select! {
                line = output.next_line() => {
                    let Ok(Some(line)) = line else { break };
                    if line.len() > 256 * 1024 { break; }
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { break };
                    match value["type"].as_str() {
                        Some("started") => { if let Some(reply) = ready.take() { let _ = reply.send(Ok(value["descriptor"].clone())); } },
                        Some("result") => { if let Some(reply) = pending.take() { let _ = reply.send(Ok(value["id"].clone())); } },
                        Some("error") => {
                            let error = value["message"].as_str().unwrap_or("HyperDHT failed").to_string();
                            if let Some(reply) = ready.take() { let _ = reply.send(Err(error.clone())); }
                            if let Some(reply) = pending.take() { let _ = reply.send(Err(error)); }
                        },
                        Some("open") => {
                            if let Some(socket) = value["id"].as_u64() { sockets.push(socket); }
                            if events.send(value).is_err() { break; }
                        },
                        Some("closed") => { sockets.retain(|socket| Some(*socket) != value["id"].as_u64()); if events.send(value).is_err() { break; } },
                        Some("frame") => { if events.send(value).is_err() { break; } },
                        _ => break,
                    }
                },
                request = rx.recv() => {
                    let Some(request) = request else { break };
                    if let Some(reply) = request.reply {
                        if pending.is_some() { let _ = reply.send(Err("A native connection attempt is already running".into())); continue; }
                        pending = Some(reply);
                    }
                    if input.write_all((request.value.to_string() + "\n").as_bytes()).await.is_err() { break; }
                },
                _ = child.wait() => break,
            }
        }
        if let Some(reply) = ready {
            let _ = reply.send(Err("HyperDHT runtime stopped during startup".into()));
        }
        if let Some(reply) = pending {
            let _ = reply.send(Err("HyperDHT runtime stopped during connection".into()));
        }
        for socket in sockets {
            let _ = events.send(json!({"type":"closed", "id":socket}));
        }
        peers.lock().unwrap().remove(&id);
        let _ = child.kill().await;
    });
    let result = tokio::time::timeout(Duration::from_secs(25), ready_rx).await;
    let descriptor = match result {
        Ok(Ok(Ok(value))) => value,
        result => {
            state.peers.lock().unwrap().remove(&id);
            return Err(match result {
                Ok(Ok(Err(error))) => error,
                _ => "HyperDHT startup timed out".into(),
            });
        }
    };
    if let Some(peer) = state.peers.lock().unwrap().get_mut(&id) {
        peer.descriptor = descriptor.clone();
    } else {
        return Err("HyperDHT runtime stopped".into());
    }
    Ok(Started { id, descriptor })
}
fn sender(state: &HyperState, id: u64) -> Result<mpsc::Sender<Request>, String> {
    Ok(state
        .peers
        .lock()
        .unwrap()
        .get(&id)
        .ok_or("HyperDHT endpoint closed")?
        .tx
        .clone())
}
#[tauri::command]
pub fn paired_hyperdht_address(
    state: State<'_, HyperState>,
    endpoint_id: u64,
) -> Result<Value, String> {
    Ok(state
        .peers
        .lock()
        .unwrap()
        .get(&endpoint_id)
        .ok_or("HyperDHT endpoint closed")?
        .descriptor
        .clone())
}
#[tauri::command]
pub async fn paired_hyperdht_connect(
    state: State<'_, HyperState>,
    endpoint_id: u64,
    descriptor: Value,
) -> Result<u64, String> {
    let key = descriptor["publicKey"]
        .as_str()
        .ok_or("Invalid HyperDHT address")?;
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid HyperDHT address".into());
    }
    let (reply, result) = oneshot::channel();
    sender(&state, endpoint_id)?
        .try_send(Request {
            value: json!({"type":"connect", "descriptor": {"publicKey":key}}),
            reply: Some(reply),
        })
        .map_err(|_| "Native command queue full")?;
    tokio::time::timeout(Duration::from_secs(25), result)
        .await
        .map_err(|_| "HyperDHT connection timed out")?
        .map_err(|_| "Native runtime stopped")??
        .as_u64()
        .ok_or("Invalid native connection ID".into())
}
#[tauri::command]
pub fn paired_hyperdht_send(
    state: State<'_, HyperState>,
    endpoint_id: u64,
    connection_id: u64,
    text: String,
) -> Result<(), String> {
    if text.is_empty() || text.len() > 60 * 1024 {
        return Err("Frame exceeds transport budget".into());
    }
    sender(&state, endpoint_id)?
        .try_send(Request {
            value: json!({"type":"send", "id":connection_id, "text":text}),
            reply: None,
        })
        .map_err(|_| "Native command queue full".into())
}
#[tauri::command]
pub fn paired_hyperdht_close(
    state: State<'_, HyperState>,
    endpoint_id: u64,
    connection_id: u64,
) -> Result<(), String> {
    sender(&state, endpoint_id)?
        .try_send(Request {
            value: json!({"type":"close", "id":connection_id}),
            reply: None,
        })
        .map_err(|_| "Native command queue full".into())
}
#[tauri::command]
pub fn paired_hyperdht_stop(state: State<'_, HyperState>, endpoint_id: u64) {
    state.peers.lock().unwrap().remove(&endpoint_id);
}

/// What the bridge refuses, and exactly what it forwards to the runtime. The
/// runtime itself (Node and sidecar.mjs) is played by a queue here.
#[cfg(test)]
mod tests {
    // covers: transport.hyperdht, transport.native-pool
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEF";

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(HyperState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    /// A runtime that only queues what it is sent.
    fn runtime(app: &tauri::App<MockRuntime>, capacity: usize) -> (u64, mpsc::Receiver<Request>) {
        let state = app.state::<HyperState>();
        let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel(capacity);
        state.peers.lock().unwrap().insert(
            id,
            Peer {
                tx,
                descriptor: json!({"publicKey": KEY}),
            },
        );
        (id, rx)
    }

    #[tokio::test]
    async fn refuses_a_bad_seed_or_a_ninth_endpoint_before_starting_anything() {
        let app = app();
        let channel = || Channel::new(|_| Ok(()));
        for seed in ["", "not base64!", &"A".repeat(42), &"A".repeat(44)] {
            assert_eq!(
                paired_hyperdht_start(app.handle().clone(), app.state(), seed.into(), channel())
                    .await
                    .err()
                    .unwrap(),
                "Invalid transport seed"
            );
        }
        let _runtimes: Vec<_> = (0..8).map(|_| runtime(&app, 1)).collect();
        use base64::Engine;
        let seed = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 32]);
        assert_eq!(
            paired_hyperdht_start(app.handle().clone(), app.state(), seed, channel())
                .await
                .err()
                .unwrap(),
            "Native endpoint limit reached"
        );
    }

    #[tokio::test]
    async fn an_address_is_a_64_hex_public_key_and_nothing_else_is_forwarded() {
        let app = app();
        let (id, mut rx) = runtime(&app, 4);
        for descriptor in [
            json!({}),
            json!({"publicKey": 7}),
            json!({"publicKey": &KEY[1..]}),
            json!({"publicKey": format!("{KEY}0")}),
            json!({"publicKey": KEY.replace('0', "g")}),
            json!("0123"),
        ] {
            assert_eq!(
                paired_hyperdht_connect(app.state(), id, descriptor.clone())
                    .await
                    .unwrap_err(),
                "Invalid HyperDHT address",
                "{descriptor}"
            );
        }
        assert!(rx.try_recv().is_err());

        let connecting = tokio::spawn({
            let handle = app.handle().clone();
            async move {
                let state = handle.state::<HyperState>();
                paired_hyperdht_connect(
                    state,
                    id,
                    json!({"publicKey": KEY, "relayThrough": "evil", "host": "10.0.0.1"}),
                )
                .await
            }
        });
        let request = rx.recv().await.unwrap();
        assert_eq!(
            request.value,
            json!({"type": "connect", "descriptor": {"publicKey": KEY}})
        );
        request.reply.unwrap().send(Ok(json!(42))).unwrap();
        assert_eq!(connecting.await.unwrap(), Ok(42));
    }

    #[tokio::test]
    async fn a_connection_answer_must_be_an_id_from_a_live_runtime() {
        let app = app();
        let (id, mut rx) = runtime(&app, 4);
        let connect = || {
            let handle = app.handle().clone();
            tokio::spawn(async move {
                paired_hyperdht_connect(handle.state::<HyperState>(), id, json!({"publicKey": KEY}))
                    .await
            })
        };
        let pending = connect();
        rx.recv()
            .await
            .unwrap()
            .reply
            .unwrap()
            .send(Ok(json!("seven")))
            .unwrap();
        assert_eq!(
            pending.await.unwrap().unwrap_err(),
            "Invalid native connection ID"
        );

        let pending = connect();
        rx.recv()
            .await
            .unwrap()
            .reply
            .unwrap()
            .send(Err("peer not found".into()))
            .unwrap();
        assert_eq!(pending.await.unwrap().unwrap_err(), "peer not found");

        let pending = connect();
        drop(rx.recv().await.unwrap());
        assert_eq!(
            pending.await.unwrap().unwrap_err(),
            "Native runtime stopped"
        );
    }

    #[tokio::test]
    async fn frames_are_bounded_and_forwarded_as_they_are() {
        let app = app();
        let (id, mut rx) = runtime(&app, 1);
        for text in [String::new(), "x".repeat(60 * 1024 + 1)] {
            assert_eq!(
                paired_hyperdht_send(app.state(), id, 3, text).unwrap_err(),
                "Frame exceeds transport budget"
            );
        }
        paired_hyperdht_send(app.state(), id, 3, "x".repeat(60 * 1024)).unwrap();
        // The queue is bounded: a runtime that stopped reading makes sends fail, not pile up.
        assert_eq!(
            paired_hyperdht_send(app.state(), id, 3, "more".into()).unwrap_err(),
            "Native command queue full"
        );
        let sent = rx.recv().await.unwrap();
        assert_eq!(sent.value["type"], "send");
        assert_eq!(sent.value["id"], 3);
        assert_eq!(sent.value["text"].as_str().unwrap().len(), 60 * 1024);
        assert!(sent.reply.is_none());

        paired_hyperdht_close(app.state(), id, 3).unwrap();
        assert_eq!(
            rx.recv().await.unwrap().value,
            json!({"type": "close", "id": 3})
        );
    }

    #[tokio::test]
    async fn a_stopped_or_unknown_endpoint_is_closed() {
        let app = app();
        let (id, _rx) = runtime(&app, 1);
        assert_eq!(
            paired_hyperdht_address(app.state(), id).unwrap(),
            json!({"publicKey": KEY})
        );
        paired_hyperdht_stop(app.state(), id);
        paired_hyperdht_stop(app.state(), id);
        let closed = "HyperDHT endpoint closed";
        assert_eq!(
            paired_hyperdht_address(app.state(), id).unwrap_err(),
            closed
        );
        assert_eq!(
            paired_hyperdht_send(app.state(), id, 1, "x".into()).unwrap_err(),
            closed
        );
        assert_eq!(
            paired_hyperdht_close(app.state(), id, 1).unwrap_err(),
            closed
        );
        assert_eq!(
            paired_hyperdht_connect(app.state(), id, json!({"publicKey": KEY}))
                .await
                .unwrap_err(),
            closed
        );
    }
}
