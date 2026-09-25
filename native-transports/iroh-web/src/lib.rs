//! Iroh (WISP 102) for the web app and the extension. A browser cannot open UDP
//! sockets, so every connection runs through an Iroh relay over WebSocket; the
//! QUIC/TLS session is still end to end between the two endpoints, so the relay
//! sees addresses and timing, never frames.
//!
//! Wire-compatible with the Desktop bridge (native-transports/src/iroh_transport.rs
//! and src-tauri/src/paired_transport.rs): same ALPN, same stream preface, same
//! u32 length-prefixed text frames, same TLS exporter binding.
use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey,
};
use n0_future::time::{timeout, Duration};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

pub const ALPN: &[u8] = b"ghostly/paired-chat/1";
pub const MAX_FRAME: usize = 60 * 1024;
const PREFACE: &[u8] = b"ghostly/paired-chat/1";
const EXPORTER_LABEL: &[u8] = b"EXPORTER-Ghostly-paired-chat-v1";

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
    let mut identities = [endpoint.id().to_string(), connection.remote_id().to_string()];
    identities.sort();
    Ok(Binding { transport: "iroh/1", context: hex(&context), identities })
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
    send.write_all(&(frame.len() as u32).to_be_bytes()).await.map_err(|e| e.to_string())?;
    send.write_all(frame).await.map_err(|e| e.to_string())
}

async fn read_frame(recv: &mut RecvStream) -> Result<Vec<u8>, String> {
    let mut header = [0u8; 4];
    recv.read_exact(&mut header).await.map_err(|e| e.to_string())?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("Frame exceeds transport budget".into());
    }
    let mut frame = vec![0; length];
    recv.read_exact(&mut frame).await.map_err(|e| e.to_string())?;
    Ok(frame)
}

/// One Iroh endpoint for one paired chat, homed on a relay.
#[wasm_bindgen]
pub struct IrohNode {
    endpoint: Endpoint,
}

#[wasm_bindgen]
impl IrohNode {
    /// Binds an endpoint for a 32-byte seed and waits until it is reachable
    /// through the first relay that answers. `relays` is a list of relay URLs.
    pub fn start(seed: Vec<u8>, relays: Vec<String>, online_ms: u32) -> js_sys::Promise {
        future_to_promise(async move {
            let seed: [u8; 32] = seed.try_into().map_err(|_| err("Invalid transport seed"))?;
            if relays.is_empty() || relays.len() > 4 {
                return Err(err("Between one and four relays are needed"));
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
            if timeout(Duration::from_millis(online_ms.into()), endpoint.online()).await.is_err() {
                endpoint.close().await;
                return Err(err("Iroh relay unreachable"));
            }
            Ok(IrohNode { endpoint }.into())
        })
    }

    /// `{ id, relay, addresses: [] }`, the same shape the Desktop publishes.
    pub fn address(&self) -> Result<JsValue, JsValue> {
        to_js(&address(&self.endpoint))
    }

    pub fn connect(&self, descriptor: JsValue, timeout_ms: u32) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            let json = js_sys::JSON::stringify(&descriptor).map_err(|_| err("Invalid descriptor"))?;
            let address: Address = serde_json::from_str(&String::from(json))
                .map_err(|_| err("Invalid descriptor"))?;
            if address.addresses.len() > 8 {
                return Err(err("Too many endpoint addresses"));
            }
            let id = address.id.parse().map_err(|_| err("Invalid Iroh endpoint ID"))?;
            let mut addr = EndpointAddr::new(id);
            if let Some(relay) = &address.relay {
                addr = addr.with_relay_url(relay.parse().map_err(|_| err("Invalid Iroh relay URL"))?);
            } else {
                // Direct addresses are useless to a browser; without a relay
                // there is no way to reach this endpoint.
                return Err(err("The contact has no Iroh relay"));
            }
            let connection = timeout(Duration::from_millis(timeout_ms.into()), endpoint.connect(addr, ALPN))
                .await
                .map_err(|_| err("Iroh connection timed out"))?
                .map_err(err)?;
            IrohConn::attach(&endpoint, connection, false).await.map(Into::into)
        })
    }

    /// Resolves with the next incoming connection, or `undefined` once closed.
    pub fn accept(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
        future_to_promise(async move {
            loop {
                let Some(incoming) = endpoint.accept().await else { return Ok(JsValue::UNDEFINED) };
                // A failed or slow handshake is dropped; the next one is awaited.
                let Ok(Ok(connection)) = timeout(Duration::from_secs(10), incoming).await else { continue };
                if let Ok(conn) = IrohConn::attach(&endpoint, connection, true).await {
                    return Ok(conn.into());
                }
            }
        })
    }

    pub fn close(&self) -> js_sys::Promise {
        let endpoint = self.endpoint.clone();
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

impl IrohConn {
    async fn attach(endpoint: &Endpoint, connection: Connection, incoming: bool) -> Result<IrohConn, JsValue> {
        let binding = binding(endpoint, &connection).map_err(err)?;
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
        let (send, recv) = match streams {
            Ok(Ok(streams)) => streams,
            Ok(Err(e)) => {
                connection.close(1u32.into(), b"stream");
                return Err(err(e));
            }
            Err(_) => {
                connection.close(1u32.into(), b"stream");
                return Err(err("Native stream timed out"));
            }
        };
        Ok(IrohConn {
            connection,
            binding,
            send: Rc::new(RefCell::new(Some(send))),
            recv: Rc::new(RefCell::new(Some(recv))),
        })
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
        self.connection.rtt(iroh::endpoint::PathId::ZERO).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(-1.0)
    }

    /// Sends one text frame. Callers serialise sends; a concurrent call fails.
    pub fn send(&self, text: String) -> js_sys::Promise {
        let slot = self.send.clone();
        future_to_promise(async move {
            let mut stream = slot.borrow_mut().take().ok_or_else(|| err("Channel busy or closed"))?;
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
            let Some(mut stream) = slot.borrow_mut().take() else { return Ok(JsValue::UNDEFINED) };
            match read_frame(&mut stream).await {
                Ok(frame) => {
                    *slot.borrow_mut() = Some(stream);
                    String::from_utf8(frame).map(Into::into).map_err(|_| err("Non-text paired frame"))
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
