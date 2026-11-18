//! Iroh (WISP 102) for the web app and the extension. A browser cannot open UDP
//! sockets, so every connection runs through an Iroh relay over WebSocket; the
//! QUIC/TLS session is still end to end between the two endpoints, so the relay
//! sees addresses and timing, never frames.
//!
//! Wire-compatible with the Desktop bridge (native-transports/src/iroh_transport.rs
//! and src-tauri/src/paired_transport.rs): same ALPN, same stream preface, same
//! u32 length-prefixed text frames, same TLS exporter binding.
use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream, WeakConnectionHandle},
    Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey,
};
use n0_future::{
    task::{AbortHandle, JoinSet},
    time::{timeout, Duration},
    FutureExt,
};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::VecDeque, rc::Rc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

pub const ALPN: &[u8] = b"ghostly/paired-chat/1";
pub const MAX_FRAME: usize = 60 * 1024;
const PREFACE: &[u8] = b"ghostly/paired-chat/1";
const EXPORTER_LABEL: &[u8] = b"EXPORTER-Ghostly-paired-chat-v1";
/// How many incoming connections are admitted at once (a handshake, then a stream with its preface), as the Desktop.
const ADMITTING: usize = 4;
/// How many incoming connections that sent the preface may be open at once, as the Desktop.
const INCOMING_OPEN: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Address {
    pub id: String,
    pub relay: Option<String>,
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Binding {
    pub transport: &'static str,
    pub context: String,
    pub identities: [String; 2],
}

fn err(message: impl std::fmt::Display) -> JsValue {
    JsError::new(&message.to_string()).into()
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let json = serde_json::to_string(value).map_err(err)?;
    js_sys::JSON::parse(&json)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn binding(endpoint: &Endpoint, connection: &Connection) -> Result<Binding, String> {
    if connection.alpn() != ALPN {
        return Err("Unexpected Iroh ALPN".into());
    }
    let mut context = [0u8; 32];
    connection
        .export_keying_material(&mut context, EXPORTER_LABEL, ALPN)
        .map_err(|_| "TLS exporter unavailable".to_string())?;
    let mut identities = [
        endpoint.id().to_string(),
        connection.remote_id().to_string(),
    ];
    identities.sort();
    Ok(Binding {
        transport: "iroh/1",
        context: hex(&context),
        identities,
    })
}

fn address(endpoint: &Endpoint) -> Address {
    let addr = endpoint.addr();
    let relay = addr.relay_urls().next().map(ToString::to_string);
    Address {
        id: endpoint.id().to_string(),
        relay,
        // A browser has no direct addresses: it is reachable only through its relay.
        addresses: Vec::new(),
    }
}

async fn write_frame(send: &mut SendStream, frame: &[u8]) -> Result<(), String> {
    if frame.is_empty() || frame.len() > MAX_FRAME {
        return Err("Frame exceeds transport budget".into());
    }
    send.write_all(&(frame.len() as u32).to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    send.write_all(frame).await.map_err(|e| e.to_string())
}

async fn read_frame(recv: &mut RecvStream) -> Result<Vec<u8>, String> {
    let mut header = [0u8; 4];
    recv.read_exact(&mut header)
        .await
        .map_err(|e| e.to_string())?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("Frame exceeds transport budget".into());
    }
    let mut frame = vec![0; length];
    recv.read_exact(&mut frame)
        .await
        .map_err(|e| e.to_string())?;
    Ok(frame)
}

/// A connection whose stream is open: the preface sent (outgoing) or read (incoming).
struct Streams {
    connection: Connection,
    binding: Binding,
    send: SendStream,
    recv: RecvStream,
}

async fn streams(
    endpoint: &Endpoint,
    connection: Connection,
    incoming: bool,
) -> Result<Streams, String> {
    let binding = binding(endpoint, &connection)?;
    let streams = timeout(Duration::from_secs(10), async {
        if incoming {
            let (send, mut recv) = connection.accept_bi().await.map_err(|e| e.to_string())?;
            if read_frame(&mut recv).await? != PREFACE {
                return Err("Invalid stream preface".to_string());
            }
            Ok((send, recv))
        } else {
            let (mut send, recv) = connection.open_bi().await.map_err(|e| e.to_string())?;
            write_frame(&mut send, PREFACE).await?;
            Ok((send, recv))
        }
    })
    .await;
    match streams {
        Ok(Ok((send, recv))) => Ok(Streams {
            connection,
            binding,
            send,
            recv,
        }),
        Ok(Err(e)) => {
            connection.close(1u32.into(), b"stream");
            Err(e)
        }
        Err(_) => {
            connection.close(1u32.into(), b"stream");
            Err("Native stream timed out".into())
        }
    }
}

/// The incoming connections of one endpoint: those being admitted, and those handed over (held weakly, so a channel
/// dropped without a close is not counted).
#[derive(Default)]
struct Admission {
    admitting: JoinSet<Option<Streams>>,
    order: VecDeque<AbortHandle>,
    open: Vec<WeakConnectionHandle>,
}

enum Next {
    Incoming(Option<iroh::endpoint::Incoming>),
    Admitted(Option<Streams>),
}

/// The next incoming connection that sent the preface, or None once the endpoint is closed. Each is admitted beside
/// the others, so one that stalls never holds the next: at most `ADMITTING` are unfinished at once (a new one past
/// that drops the oldest), and at most `INCOMING_OPEN` handed over are open (one past that is closed). This side's
/// own dials are not counted: one always goes out.
async fn next_incoming(endpoint: &Endpoint, admission: &mut Admission) -> Option<Streams> {
    loop {
        let accepting = async { Next::Incoming(endpoint.accept().await) };
        let next = if admission.admitting.is_empty() {
            accepting.await
        } else {
            let admitting = &mut admission.admitting;
            accepting
                .or(async {
                    Next::Admitted(admitting.join_next().await.and_then(Result::ok).flatten())
                })
                .await
        };
        match next {
            Next::Incoming(None) => return None,
            Next::Incoming(Some(incoming)) => {
                admission.order.retain(|admitting| !admitting.is_finished());
                if admission.order.len() >= ADMITTING {
                    if let Some(oldest) = admission.order.pop_front() {
                        oldest.abort();
                    }
                }
                let endpoint = endpoint.clone();
                admission
                    .order
                    .push_back(admission.admitting.spawn(async move {
                        let connection = timeout(Duration::from_secs(10), incoming)
                            .await
                            .ok()?
                            .ok()?;
                        streams(&endpoint, connection, true).await.ok()
                    }));
            }
            Next::Admitted(Some(streams)) => {
                admission.open.retain(|open| {
                    open.upgrade()
                        .is_some_and(|connection| connection.close_reason().is_none())
                });
                if admission.open.len() >= INCOMING_OPEN {
                    streams.connection.close(1u32.into(), b"connection limit");
                    continue;
                }
                admission.open.push(streams.connection.weak_handle());
                return Some(streams);
            }
            Next::Admitted(None) => {}
        }
    }
}

/// One Iroh endpoint for one paired chat, homed on a relay.
#[wasm_bindgen]
pub struct IrohNode {
    endpoint: Endpoint,
    /// Taken by the `accept` in progress; None while one is, or once the endpoint closed.
    admission: Rc<RefCell<Option<Admission>>>,
}

#[wasm_bindgen]
impl IrohNode {
    /// Binds an endpoint for a 32-byte seed and waits until it is reachable
    /// through the first relay that answers. `relays` is a list of relay URLs.
    pub fn start(seed: Vec<u8>, relays: Vec<String>, online_ms: u32) -> js_sys::Promise {
        future_to_promise(async move {
            let seed: [u8; 32] = seed.try_into().map_err(|_| err("Invalid transport seed"))?;
            if relays.is_empty() || relays.len() > 5 {
                return Err(err("Between one and five relays are needed"));
            }
            let urls = relays
                .iter()
                .map(|u| u.parse::<RelayUrl>())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| err("Invalid Iroh relay URL"))?;
            let map = RelayMap::from_iter(urls.into_iter().map(iroh::RelayConfig::from));
            let endpoint = Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Custom(map))
                .secret_key(SecretKey::from_bytes(&seed))
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .map_err(err)?;
            if timeout(Duration::from_millis(online_ms.into()), endpoint.online())
                .await
                .is_err()
            {
                endpoint.close().await;
                return Err(err("Iroh relay unreachable"));
            }
            Ok(IrohNode {
                endpoint,
                admission: Rc::new(RefCell::new(Some(Admission::default()))),
            }
            .into())
        })
    }

    /// `{ id, relay, addresses: [] }`, the same shape the Desktop publishes.
    pub fn address(&self) -> Result<JsValue, JsValue> {
        to_js(&address(&self.endpoint))
    }

    pub fn connect(&self, descriptor: JsValue, timeout_ms: u32) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            let json =
                js_sys::JSON::stringify(&descriptor).map_err(|_| err("Invalid descriptor"))?;
            let address: Address =
                serde_json::from_str(&String::from(json)).map_err(|_| err("Invalid descriptor"))?;
            if address.addresses.len() > 8 {
                return Err(err("Too many endpoint addresses"));
            }
            let id = address
                .id
                .parse()
                .map_err(|_| err("Invalid Iroh endpoint ID"))?;
            let mut addr = EndpointAddr::new(id);
            if let Some(relay) = &address.relay {
                addr =
                    addr.with_relay_url(relay.parse().map_err(|_| err("Invalid Iroh relay URL"))?);
            } else {
                // Direct addresses are useless to a browser; without a relay
                // there is no way to reach this endpoint.
                return Err(err("The contact has no Iroh relay"));
            }
            let connection = timeout(
                Duration::from_millis(timeout_ms.into()),
                endpoint.connect(addr, ALPN),
            )
            .await
            .map_err(|_| err("Iroh connection timed out"))?
            .map_err(err)?;
            streams(&endpoint, connection, false)
                .await
                .map(|streams| IrohConn::from(streams).into())
                .map_err(err)
        })
    }

    /// Resolves with the next incoming connection, or `undefined` once closed. Callers serialise accepts; a
    /// concurrent call fails.
    pub fn accept(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        let slot = self.admission.clone();
        future_to_promise(async move {
            let mut admission = slot
                .borrow_mut()
                .take()
                .ok_or_else(|| err("Accept busy or closed"))?;
            let Some(streams) = next_incoming(&endpoint, &mut admission).await else {
                return Ok(JsValue::UNDEFINED);
            };
            *slot.borrow_mut() = Some(admission);
            Ok(IrohConn::from(streams).into())
        })
    }

    pub fn close(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        // Every admission still unfinished goes with it.
        self.admission.borrow_mut().take();
        future_to_promise(async move {
            endpoint.close().await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

/// One paired channel: a single bidirectional stream of text frames.
#[wasm_bindgen]
pub struct IrohConn {
    connection: Connection,
    binding: Binding,
    send: Rc<RefCell<Option<SendStream>>>,
    recv: Rc<RefCell<Option<RecvStream>>>,
}

impl From<Streams> for IrohConn {
    fn from(streams: Streams) -> Self {
        IrohConn {
            connection: streams.connection,
            binding: streams.binding,
            send: Rc::new(RefCell::new(Some(streams.send))),
            recv: Rc::new(RefCell::new(Some(streams.recv))),
        }
    }
}

#[wasm_bindgen]
impl IrohConn {
    pub fn binding(&self) -> Result<JsValue, JsValue> {
        to_js(&self.binding)
    }

    /// The contact's endpoint id.
    #[wasm_bindgen(js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.connection.remote_id().to_string()
    }

    /// Round-trip time in milliseconds, as QUIC measures it.
    pub fn rtt(&self) -> f64 {
        self.connection
            .rtt(iroh::endpoint::PathId::ZERO)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(-1.0)
    }

    /// Sends one text frame. Callers serialise sends; a concurrent call fails.
    pub fn send(&self, text: String) -> js_sys::Promise {
        let slot = self.send.clone();
        future_to_promise(async move {
            let mut stream = slot
                .borrow_mut()
                .take()
                .ok_or_else(|| err("Channel busy or closed"))?;
            let result = write_frame(&mut stream, text.as_bytes()).await;
            if result.is_ok() {
                *slot.borrow_mut() = Some(stream);
            }
            result.map(|_| JsValue::UNDEFINED).map_err(err)
        })
    }

    /// The next text frame, or `undefined` once the channel is closed.
    pub fn recv(&self) -> js_sys::Promise {
        let slot = self.recv.clone();
        future_to_promise(async move {
            let Some(mut stream) = slot.borrow_mut().take() else {
                return Ok(JsValue::UNDEFINED);
            };
            match read_frame(&mut stream).await {
                Ok(frame) => {
                    *slot.borrow_mut() = Some(stream);
                    String::from_utf8(frame)
                        .map(Into::into)
                        .map_err(|_| err("Non-text paired frame"))
                }
                Err(_) => Ok(JsValue::UNDEFINED),
            }
        })
    }

    pub fn close(&self) {
        self.send.borrow_mut().take();
        self.recv.borrow_mut().take();
        self.connection.close(0u32.into(), b"closed");
    }
}

/// Admission, run natively on loopback (the wasm build is the same code with a relay in between).
#[cfg(all(test, not(target_arch = "wasm32")))]
mod admission {
    use super::*;

    async fn bind(seed: u8) -> Endpoint {
        Endpoint::builder(presets::Minimal)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .unwrap()
            .secret_key(SecretKey::from_bytes(&[seed; 32]))
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap()
    }

    /// A dial that completes the handshake and nothing else: no stream, no preface.
    async fn stall(from: &Endpoint, to: &Endpoint) -> Connection {
        from.connect(to.addr(), ALPN).await.unwrap()
    }

    async fn dial(from: &Endpoint, to: &Endpoint) -> Streams {
        let connection = from.connect(to.addr(), ALPN).await.unwrap();
        streams(from, connection, false).await.unwrap()
    }

    #[tokio::test]
    async fn a_dial_that_never_sends_the_preface_does_not_hold_the_next() {
        let (listener, stranger, contact) = (bind(1).await, bind(2).await, bind(3).await);
        let mut admission = Admission::default();
        let accepting = async {
            let mut held = Vec::new();
            for _ in 0..3 {
                held.push(stall(&stranger, &listener).await);
            }
            let _dialled = dial(&contact, &listener).await;
            std::future::pending::<()>().await;
        };
        let admitted = timeout(
            Duration::from_secs(5),
            next_incoming(&listener, &mut admission).or(async {
                accepting.await;
                None
            }),
        )
        .await
        .expect("the contact's dial waited behind the stranger's")
        .unwrap();
        assert_eq!(admitted.connection.remote_id(), contact.id());
    }

    #[tokio::test]
    async fn at_most_two_incoming_connections_are_open_at_once() {
        let (listener, stranger) = (bind(4).await, bind(5).await);
        let mut admission = Admission::default();
        let (a, first) = tokio::join!(
            next_incoming(&listener, &mut admission),
            dial(&stranger, &listener)
        );
        let (b, _second) = tokio::join!(
            next_incoming(&listener, &mut admission),
            dial(&stranger, &listener)
        );
        let (a, _b) = (a.unwrap(), b.unwrap());

        let refused = timeout(
            Duration::from_secs(5),
            next_incoming(&listener, &mut admission).or(async {
                let third = dial(&stranger, &listener).await;
                third.connection.closed().await;
                None
            }),
        )
        .await
        .expect("the third connection was neither refused nor admitted");
        assert!(refused.is_none(), "a third connection was admitted");

        // One closed, the next one is admitted.
        a.connection.close(0u32.into(), b"closed");
        first.connection.closed().await;
        let (admitted, _fourth) = timeout(Duration::from_secs(5), async {
            tokio::join!(
                next_incoming(&listener, &mut admission),
                dial(&stranger, &listener)
            )
        })
        .await
        .expect("a connection was refused with only one open");
        assert_eq!(admitted.unwrap().connection.remote_id(), stranger.id());
    }
}
