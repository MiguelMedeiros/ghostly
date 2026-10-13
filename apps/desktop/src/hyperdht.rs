//! Fixed packaged HyperDHT runtime, controlled over private pipes. This bridge
//! cannot launch arbitrary programs or expose a network administration port.
//!
//! One runtime serves the whole app: every chat's endpoint lives in it under
//! the number this bridge gave it. It starts with the first endpoint, starts
//! again only if it died, and ends with the last endpoint or with the app (the
//! runtime leaves as soon as the pipe to the app closes).
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdout, Command},
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
type Peers = Arc<Mutex<HashMap<u64, Peer>>>;
type Slot = Arc<tokio::sync::Mutex<Option<Runtime>>>;

/// What the runtime says about one endpoint goes to that endpoint's page.
struct Route {
    events: Channel<Value>,
    ready: Option<Reply>,
    pending: Option<Reply>,
    sockets: Vec<u64>,
}
type Routes = Arc<Mutex<HashMap<u64, Route>>>;
impl Route {
    fn close(self, error: &str) {
        if let Some(reply) = self.ready {
            let _ = reply.send(Err(format!("{error} during startup")));
        }
        if let Some(reply) = self.pending {
            let _ = reply.send(Err(format!("{error} during connection")));
        }
        for socket in self.sockets {
            let _ = self.events.send(json!({"type":"closed", "id":socket}));
        }
        // The page does not ask whether its endpoint is still there: it is told, here, whether the runtime died,
        // dropped the endpoint, or the page itself stopped it (which it then ignores).
        let _ = self.events.send(json!({"type":"stopped"}));
    }
}

/// The running Node process. Dropping this asks it to leave.
struct Runtime {
    generation: u64,
    lines: mpsc::Sender<String>,
    routes: Routes,
    exited: Arc<AtomicBool>,
    #[cfg_attr(not(test), allow(dead_code))]
    pid: Option<u32>,
    _leave: oneshot::Sender<()>,
}

#[derive(Clone, Default)]
pub struct HyperState {
    peers: Peers,
    next: Arc<AtomicU64>,
    runtime: Slot,
    spawned: Arc<AtomicU64>,
    /// Node and the script, when a test brings its own.
    program: Option<(PathBuf, PathBuf)>,
}
#[derive(Serialize, Debug)]
pub struct Started {
    id: u64,
    descriptor: Value,
}

fn packaged<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(PathBuf, PathBuf), String> {
    let mut root = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("native-runtime");
    #[cfg(debug_assertions)]
    if !root.join("sidecar.mjs").exists() {
        root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("native-runtime");
    }
    let executable = root.join(if cfg!(windows) { "node.exe" } else { "node" });
    Ok((executable, root.join("sidecar.mjs")))
}

impl HyperState {
    /// The Ghostly window's page starts (`TransportState::page_started` says when and why): the endpoints the page
    /// before it held are stopped, as `paired_hyperdht_stop` stops one. One still starting ends as "stopped".
    pub fn page_started(&self) {
        self.peers.lock().unwrap().clear();
    }

    /// Starts the runtime. Called with the slot locked, so two endpoints
    /// starting at once never start two.
    fn spawn(&self, program: (PathBuf, PathBuf)) -> Result<Runtime, String> {
        let (executable, script) = program;
        let mut child = Command::new(executable)
            .arg(script)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Packaged HyperDHT runtime unavailable: {e}"))?;
        let generation = self.spawned.fetch_add(1, Ordering::Relaxed) + 1;
        let mut input = child.stdin.take().ok_or("Native stdin unavailable")?;
        let output = child.stdout.take().ok_or("Native stdout unavailable")?;
        let (lines, mut queued) = mpsc::channel::<String>(64);
        let (leave, left) = oneshot::channel::<()>();
        let routes = Routes::default();
        let exited = Arc::new(AtomicBool::new(false));
        let pid = child.id();

        tokio::spawn(async move {
            while let Some(line) = queued.recv().await {
                if input.write_all((line + "\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        // A runtime that says something it should not is stopped, as one that says nothing more.
        let reader = tokio::spawn(read(output, routes.clone(), self.peers.clone()));
        let (slot, peers, routes_, exited_, leaving) = (
            self.runtime.clone(),
            self.peers.clone(),
            routes.clone(),
            exited.clone(),
            lines.clone(),
        );
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {},
                _ = reader => {},
                _ = left => {
                    // Asked first, so every DHT node closes properly; then made to.
                    let _ = leaving.try_send(json!({"type":"shutdown"}).to_string());
                    drop(leaving);
                    if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                        let _ = child.kill().await;
                    }
                },
            }
            let _ = child.kill().await;
            exited_.store(true, Ordering::SeqCst);
            {
                let mut slot = slot.lock().await;
                if slot.as_ref().is_some_and(|r| r.generation == generation) {
                    *slot = None;
                }
            }
            // Its endpoints are gone with it. Their forwarders tell their pages.
            let ids: Vec<u64> = routes_.lock().unwrap().keys().copied().collect();
            let mut peers = peers.lock().unwrap();
            for id in ids {
                peers.remove(&id);
            }
        });
        Ok(Runtime {
            generation,
            lines,
            routes,
            exited,
            pid,
            _leave: leave,
        })
    }
}

/// Everything the runtime prints, to the endpoint it names.
async fn read(output: ChildStdout, routes: Routes, peers: Peers) {
    let mut output = BufReader::new(output).lines();
    while let Ok(Some(line)) = output.next_line().await {
        if line.len() > 256 * 1024 {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        let Some(id) = value["endpoint"].as_u64() else {
            break;
        };
        let mut gone = false;
        {
            let mut routes = routes.lock().unwrap();
            // A late word about an endpoint that was already stopped.
            let Some(route) = routes.get_mut(&id) else {
                continue;
            };
            match value["type"].as_str() {
                Some("started") => {
                    if let Some(reply) = route.ready.take() {
                        let _ = reply.send(Ok(value["descriptor"].clone()));
                    }
                }
                Some("result") => {
                    if let Some(reply) = route.pending.take() {
                        let _ = reply.send(Ok(value["id"].clone()));
                    }
                }
                // The page counts a frame against its send budget until it hears this.
                Some("sent") => {
                    let sent = json!({"type":"sent", "id":value["id"], "seq":value["seq"]});
                    gone = route.events.send(sent).is_err();
                }
                // A frame that could not go is never lost unseen: the page closes its channel.
                Some("error") if value["command"] == "send" => {
                    let unsent = json!({"type":"unsent", "id":value["id"], "seq":value["seq"]});
                    gone = route.events.send(unsent).is_err();
                }
                Some("error") => {
                    let error = value["message"]
                        .as_str()
                        .unwrap_or("HyperDHT failed")
                        .to_string();
                    let reply = match value["command"].as_str() {
                        Some("start") => route.ready.take(),
                        Some("connect") => route.pending.take(),
                        _ => None,
                    };
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(error));
                    }
                }
                Some("open") => {
                    if let Some(socket) = value["id"].as_u64() {
                        route.sockets.push(socket);
                    }
                    gone = route.events.send(value).is_err();
                }
                Some("closed") => {
                    route
                        .sockets
                        .retain(|socket| Some(*socket) != value["id"].as_u64());
                    gone = route.events.send(value).is_err();
                }
                Some("frame") => gone = route.events.send(value).is_err(),
                Some("stopped") => gone = true,
                _ => break,
            }
        }
        // Its page is gone, or the runtime dropped it: stopped like any other.
        if gone {
            peers.lock().unwrap().remove(&id);
        }
    }
}

/// Carries one endpoint's commands to the runtime until the endpoint is
/// stopped (its sender dropped), then stops it there too; the last one out
/// lets the runtime go.
async fn forward(
    id: u64,
    mut rx: mpsc::Receiver<Request>,
    lines: mpsc::Sender<String>,
    routes: Routes,
    generation: u64,
    slot: Slot,
) {
    while let Some(request) = rx.recv().await {
        let mut value = request.value;
        if let Some(reply) = request.reply {
            let mut routes = routes.lock().unwrap();
            let Some(route) = routes.get_mut(&id) else {
                let _ = reply.send(Err("HyperDHT endpoint closed".into()));
                continue;
            };
            if route.pending.is_some() {
                let _ = reply.send(Err("A native connection attempt is already running".into()));
                continue;
            }
            route.pending = Some(reply);
        }
        value["endpoint"] = json!(id);
        if lines.send(value.to_string()).await.is_err() {
            break;
        }
    }
    let stop = json!({"type":"stop", "endpoint":id}).to_string();
    let _ = tokio::time::timeout(Duration::from_secs(5), lines.send(stop)).await;
    if let Some(route) = routes.lock().unwrap().remove(&id) {
        route.close("HyperDHT runtime stopped");
    }
    let mut slot = slot.lock().await;
    if slot
        .as_ref()
        .is_some_and(|r| r.generation == generation && r.routes.lock().unwrap().is_empty())
    {
        *slot = None;
    }
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
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel::<Request>(32);
    let (ready_tx, ready_rx) = oneshot::channel();
    {
        let mut slot = state.runtime.lock().await;
        if state.peers.lock().unwrap().len() >= 8 {
            return Err("Native endpoint limit reached".into());
        }
        if slot
            .as_ref()
            .is_some_and(|r| r.exited.load(Ordering::SeqCst))
        {
            *slot = None;
        }
        if slot.is_none() {
            let program = match &state.program {
                Some(program) => program.clone(),
                None => packaged(&app)?,
            };
            *slot = Some(state.spawn(program)?);
        }
        let runtime = slot.as_ref().expect("runtime");
        runtime.routes.lock().unwrap().insert(
            id,
            Route {
                events,
                ready: Some(ready_tx),
                pending: None,
                sockets: Vec::new(),
            },
        );
        state.peers.lock().unwrap().insert(
            id,
            Peer {
                tx,
                descriptor: Value::Null,
            },
        );
        let start = json!({"type":"start", "endpoint":id, "seedB64":seed_b64}).to_string();
        let started = runtime.lines.try_send(start).is_ok();
        tokio::spawn(forward(
            id,
            rx,
            runtime.lines.clone(),
            runtime.routes.clone(),
            runtime.generation,
            state.runtime.clone(),
        ));
        if !started {
            state.peers.lock().unwrap().remove(&id);
            return Err("Native command queue full".into());
        }
    }
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
/// One frame: `text`, or `bytes` (a binary message, WISP 103 § Frames, in base64), as the runtime takes it. Answered
/// once queued for the runtime, in the order the page sends; the runtime's word comes on the page's channel under
/// `seq`: `sent` once its socket has room for more (the page counts the frame against its send budget until then, so
/// several are in flight and none waits a round trip to the runtime), `unsent` when it could not send it.
#[tauri::command]
pub async fn paired_hyperdht_send(
    state: State<'_, HyperState>,
    endpoint_id: u64,
    connection_id: u64,
    seq: u64,
    text: Option<String>,
    bytes: Option<String>,
) -> Result<(), String> {
    use base64::Engine;
    let (field, size, frame) = match (text, bytes) {
        (Some(text), None) => ("text", text.len(), text),
        (None, Some(bytes)) => (
            "bytes",
            base64::engine::general_purpose::STANDARD
                .decode(&bytes)
                .map_err(|_| "Invalid binary frame")?
                .len(),
            bytes,
        ),
        _ => return Err("Invalid frame".into()),
    };
    if size == 0 || size > 60 * 1024 {
        return Err("Frame exceeds transport budget".into());
    }
    let mut value = json!({"type":"send", "id":connection_id, "seq":seq});
    value[field] = json!(frame);
    // A runtime slower than the page fills the queue: the page's next send waits here, behind this one.
    sender(&state, endpoint_id)?
        .send(Request { value, reply: None })
        .await
        .map_err(|_| "HyperDHT endpoint closed".into())
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

    /// A send to the runtime, in the background as the page's invoke is.
    fn sending(
        app: &tauri::App<MockRuntime>,
        id: u64,
        seq: u64,
        text: Option<String>,
        bytes: Option<String>,
    ) -> tokio::task::JoinHandle<Result<(), String>> {
        let handle = app.handle().clone();
        tokio::spawn(async move {
            paired_hyperdht_send(handle.state::<HyperState>(), id, 3, seq, text, bytes).await
        })
    }

    #[tokio::test]
    async fn frames_are_bounded_forwarded_as_they_are_and_answered_once_queued() {
        let app = app();
        let (id, mut rx) = runtime(&app, 1);
        for text in [String::new(), "x".repeat(60 * 1024 + 1)] {
            assert_eq!(
                paired_hyperdht_send(app.state(), id, 3, 1, Some(text), None)
                    .await
                    .unwrap_err(),
                "Frame exceeds transport budget"
            );
        }
        // Answered once queued, without waiting for the runtime to write it: the runtime's `sent` reaches the page
        // on its channel, so the page's next frame goes without a round trip to the runtime.
        let first = sending(&app, id, 1, Some("x".repeat(60 * 1024)), None);
        tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .expect("answered once queued")
            .unwrap()
            .unwrap();
        // The queue is bounded: past it, the next send waits behind the ones before it instead of failing.
        let second = sending(&app, id, 2, Some("more".into()), None);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!second.is_finished());
        let sent = rx.recv().await.unwrap();
        assert_eq!(sent.value["type"], "send");
        assert_eq!(
            (&sent.value["id"], &sent.value["seq"]),
            (&json!(3), &json!(1))
        );
        assert_eq!(sent.value["text"].as_str().unwrap().len(), 60 * 1024);
        assert!(sent.reply.is_none());
        assert_eq!(second.await.unwrap(), Ok(()));
        let more = rx.recv().await.unwrap();
        assert_eq!(
            (&more.value["text"], &more.value["seq"]),
            (&json!("more"), &json!(2))
        );

        paired_hyperdht_close(app.state(), id, 3).unwrap();
        assert_eq!(
            rx.recv().await.unwrap().value,
            json!({"type": "close", "id": 3})
        );
    }

    /// A binary message comes as base64, within the same budget as text, and goes to the runtime as it came.
    #[tokio::test]
    async fn a_binary_frame_is_base64_within_the_budget_and_forwarded_as_it_is() {
        use base64::Engine;
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let app = app();
        let (id, mut rx) = runtime(&app, 1);
        for (text, bytes, error) in [
            (None, None, "Invalid frame"),
            (Some("x".into()), Some(encode(b"x")), "Invalid frame"),
            (None, Some("not base64!".into()), "Invalid binary frame"),
            (None, Some(String::new()), "Frame exceeds transport budget"),
            (
                None,
                Some(encode(&vec![4u8; 60 * 1024 + 1])),
                "Frame exceeds transport budget",
            ),
        ] {
            assert_eq!(
                paired_hyperdht_send(app.state(), id, 3, 1, text, bytes)
                    .await
                    .unwrap_err(),
                error
            );
        }
        let largest = encode(&vec![4u8; 60 * 1024]);
        let sent = sending(&app, id, 1, None, Some(largest.clone()));
        let request = rx.recv().await.unwrap();
        assert_eq!(
            request.value,
            json!({"type": "send", "id": 3, "seq": 1, "bytes": largest})
        );
        assert_eq!(sent.await.unwrap(), Ok(()));
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
            paired_hyperdht_send(app.state(), id, 1, 1, Some("x".into()), None)
                .await
                .unwrap_err(),
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

/// The real sidecar.mjs, run by Node, over endpoints held in memory
/// (`native/transports/hyperdht/test/fake-endpoint.mjs`): how many processes
/// there are, and when they go.
#[cfg(all(test, unix))]
mod runtime_tests {
    // covers: transport.native-pool
    use super::*;
    use tauri::ipc::InvokeResponseBody;
    use tauri::test::{mock_builder, MockRuntime};

    /// A folder holding the sidecar with the fake endpoint in place of the real
    /// one, made once per test run.
    fn program() -> (PathBuf, PathBuf) {
        static PROGRAM: std::sync::OnceLock<(PathBuf, PathBuf)> = std::sync::OnceLock::new();
        PROGRAM
            .get_or_init(|| {
                let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../native/transports/hyperdht");
                let folder =
                    std::env::temp_dir().join(format!("ghostly-hyperdht-{}", std::process::id()));
                std::fs::create_dir_all(&folder).unwrap();
                std::fs::copy(source.join("sidecar.mjs"), folder.join("sidecar.mjs")).unwrap();
                std::fs::copy(
                    source.join("test/fake-endpoint.mjs"),
                    folder.join("endpoint.mjs"),
                )
                .unwrap();
                let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .map(|dir| dir.join("node"))
                    .find(|path| path.is_file())
                    .expect("node on PATH");
                (node, folder.join("sidecar.mjs"))
            })
            .clone()
    }

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(HyperState {
                program: Some(program()),
                ..HyperState::default()
            })
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn seed(byte: u8) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([byte; 32])
    }

    /// A page's channel, and what reaches it.
    fn page() -> (Channel<Value>, mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let _ = tx.send(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, rx)
    }

    async fn start(app: &tauri::App<MockRuntime>, byte: u8) -> Result<Started, String> {
        paired_hyperdht_start(app.handle().clone(), app.state(), seed(byte), page().0).await
    }

    async fn pid(app: &tauri::App<MockRuntime>) -> Option<u32> {
        app.state::<HyperState>()
            .runtime
            .lock()
            .await
            .as_ref()
            .and_then(|r| r.pid)
    }

    fn spawned(app: &tauri::App<MockRuntime>) -> u64 {
        app.state::<HyperState>().spawned.load(Ordering::Relaxed)
    }

    fn alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    async fn until(what: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..200 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{what} did not happen in 10 s");
    }

    async fn next(events: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("an event in 10 s")
            .expect("the page's channel open")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_endpoint_lives_in_one_runtime_that_leaves_with_the_last() {
        let app = app();
        let (events_a, mut page_a) = page();
        let (events_b, mut page_b) = page();
        let a = paired_hyperdht_start(app.handle().clone(), app.state(), seed(1), events_a)
            .await
            .unwrap();
        let b = paired_hyperdht_start(app.handle().clone(), app.state(), seed(2), events_b)
            .await
            .unwrap();
        let c = start(&app, 3).await.unwrap();
        assert_eq!(spawned(&app), 1, "three endpoints, one process");
        let runtime = pid(&app).await.unwrap();
        assert_eq!(a.descriptor, json!({"publicKey": "01".repeat(32)}));

        // Each endpoint hears only about its own connections.
        let connection = paired_hyperdht_connect(app.state(), a.id, b.descriptor.clone())
            .await
            .unwrap();
        let opened = next(&mut page_a).await;
        assert_eq!(
            (&opened["type"], &opened["id"], &opened["incoming"]),
            (&json!("open"), &json!(connection), &json!(false))
        );
        let incoming = next(&mut page_b).await;
        assert_eq!(incoming["incoming"], true);
        paired_hyperdht_send(app.state(), a.id, connection, 1, Some("hello".into()), None)
            .await
            .unwrap();
        let frame = next(&mut page_b).await;
        assert_eq!(
            (&frame["type"], &frame["text"]),
            (&json!("frame"), &json!("hello"))
        );
        assert_eq!(frame["id"], incoming["id"]);
        // The sender's page hears that it went, under the number it sent it with.
        assert_eq!(
            next(&mut page_a).await,
            json!({"type":"sent", "id":connection, "seq":1})
        );
        // A binary message, in base64 through the runtime and back.
        paired_hyperdht_send(
            app.state(),
            a.id,
            connection,
            2,
            None,
            Some("BAD/Cg==".into()),
        )
        .await
        .unwrap();
        let frame = next(&mut page_b).await;
        assert_eq!(
            (&frame["type"], &frame["bytes"], &frame["id"]),
            (&json!("frame"), &json!("BAD/Cg=="), &incoming["id"])
        );
        assert_eq!(
            next(&mut page_a).await,
            json!({"type":"sent", "id":connection, "seq":2})
        );
        // A frame the runtime cannot send is told to the page, not lost unseen.
        paired_hyperdht_send(app.state(), a.id, 999, 3, Some("nowhere".into()), None)
            .await
            .unwrap();
        assert_eq!(
            next(&mut page_a).await,
            json!({"type":"unsent", "id":999, "seq":3})
        );
        assert!(page_a.try_recv().is_err());

        // Stopping one closes its connection on both ends, and keeps the runtime.
        paired_hyperdht_stop(app.state(), a.id);
        assert_eq!(
            next(&mut page_a).await,
            json!({"type":"closed", "id":connection})
        );
        assert_eq!(next(&mut page_a).await, json!({"type":"stopped"}));
        let closed = next(&mut page_b).await;
        assert_eq!(
            (&closed["type"], &closed["id"]),
            (&json!("closed"), &incoming["id"])
        );
        paired_hyperdht_stop(app.state(), c.id);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(pid(&app).await, Some(runtime));
        assert!(alive(runtime));

        // The last one out lets it go.
        paired_hyperdht_stop(app.state(), b.id);
        until("the runtime leaving", || !alive(runtime)).await;
        assert_eq!(pid(&app).await, None);

        // The next endpoint starts it again.
        start(&app, 4).await.unwrap();
        assert_eq!(spawned(&app), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn endpoints_starting_at_once_start_one_runtime() {
        let app = app();
        let started = futures_util::future::join_all((1..=8).map(|byte| start(&app, byte))).await;
        assert!(
            started.iter().all(Result::is_ok),
            "{:?}",
            started.iter().find(|r| r.is_err())
        );
        assert_eq!(spawned(&app), 1);
        assert_eq!(
            start(&app, 9).await.err().unwrap(),
            "Native endpoint limit reached"
        );
        assert_eq!(spawned(&app), 1);
    }

    /// A page that starts finds its eight places free: the endpoints the page before it left running are stopped
    /// in the runtime too, which leaves with the last of them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_page_that_starts_stops_what_the_page_before_it_left_running() {
        let app = app();
        let left = futures_util::future::join_all((1..=8).map(|byte| start(&app, byte))).await;
        assert!(left.iter().all(Result::is_ok));
        let runtime = pid(&app).await.unwrap();
        assert_eq!(
            start(&app, 9).await.err().unwrap(),
            "Native endpoint limit reached"
        );

        app.state::<HyperState>().page_started();

        for endpoint in left {
            assert_eq!(
                paired_hyperdht_address(app.state(), endpoint.unwrap().id).unwrap_err(),
                "HyperDHT endpoint closed"
            );
        }
        until("the runtime leaving", || !alive(runtime)).await;
        assert_eq!(pid(&app).await, None);
        let again = futures_util::future::join_all((11..=18).map(|byte| start(&app, byte))).await;
        assert!(
            again.iter().all(Result::is_ok),
            "{:?}",
            again.iter().find(|r| r.is_err())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_runtime_that_died_takes_its_endpoints_and_is_started_again_once() {
        let app = app();
        let (events, mut page) = page();
        let a = paired_hyperdht_start(app.handle().clone(), app.state(), seed(1), events)
            .await
            .unwrap();
        let b = start(&app, 2).await.unwrap();
        let connection = paired_hyperdht_connect(app.state(), a.id, b.descriptor.clone())
            .await
            .unwrap();
        assert_eq!(next(&mut page).await["type"], "open");
        let first = pid(&app).await.unwrap();

        std::process::Command::new("kill")
            .args(["-9", &first.to_string()])
            .status()
            .unwrap();
        // Its page learns the connection is gone and then, without asking, that its endpoint is; and the
        // endpoints are closed.
        let died = std::time::Instant::now();
        assert_eq!(
            next(&mut page).await,
            json!({"type":"closed", "id":connection})
        );
        assert_eq!(next(&mut page).await, json!({"type":"stopped"}));
        assert!(
            died.elapsed() < Duration::from_secs(5),
            "{:?}",
            died.elapsed()
        );
        until("both endpoints closing", || {
            [a.id, b.id]
                .iter()
                .all(|id| paired_hyperdht_address(app.state(), *id).is_err())
        })
        .await;
        assert_eq!(pid(&app).await, None);

        // The chats reopening start one runtime between them.
        let again = futures_util::future::join_all((1..=3).map(|byte| start(&app, byte))).await;
        assert!(
            again.iter().all(Result::is_ok),
            "{again:?}",
            again = again.iter().map(|r| r.as_ref().err()).collect::<Vec<_>>()
        );
        assert_eq!(spawned(&app), 2);
        let second = pid(&app).await.unwrap();
        assert_ne!(first, second);
        assert!(alive(second));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_endpoint_the_runtime_refuses_leaves_nothing_behind() {
        let app = app();
        start(&app, 1).await.unwrap();
        // The fake, like the DHT, will not listen twice on one key.
        assert_eq!(
            start(&app, 1).await.err().unwrap(),
            "Endpoint already listening"
        );
        until("the refused endpoint being forgotten", || {
            app.state::<HyperState>().peers.lock().unwrap().len() == 1
        })
        .await;
        assert_eq!(spawned(&app), 1);
    }
}
