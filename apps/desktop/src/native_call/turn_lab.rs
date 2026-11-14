//! A TURN server for the call engine's tests, in this process: enough of RFC 8656 over UDP on IPv4 for two
//! relay-only calls to connect through it. An allocation after the 401 challenge, permissions, channel bindings,
//! a refresh, Send and Data indications, and ChannelData both ways (a server that drops a client's ChannelData
//! gives a call its candidates and then no media). It reads the username and checks no message integrity: it is
//! for tests alone.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

const COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
/// Message types: a method with its class (request, indication `0x010`, success `0x100`, error `0x110`).
const BINDING: u16 = 0x001;
const ALLOCATE: u16 = 0x003;
const REFRESH: u16 = 0x004;
const SEND: u16 = 0x016;
const DATA_INDICATION: u16 = 0x017;
const CREATE_PERMISSION: u16 = 0x008;
const CHANNEL_BIND: u16 = 0x009;
const SUCCESS: u16 = 0x100;
const ERROR: u16 = 0x110;
/// Attributes.
const USERNAME: u16 = 0x0006;
const MESSAGE_INTEGRITY: u16 = 0x0008;
const ERROR_CODE: u16 = 0x0009;
const CHANNEL_NUMBER: u16 = 0x000C;
const LIFETIME: u16 = 0x000D;
const XOR_PEER_ADDRESS: u16 = 0x0012;
const DATA: u16 = 0x0013;
const REALM: u16 = 0x0014;
const NONCE: u16 = 0x0015;
const XOR_RELAYED_ADDRESS: u16 = 0x0016;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

const LIFETIME_S: u32 = 600;

/// What one client was allocated: its relay socket, the peers it permits and the channels it bound to them.
struct Allocation {
    relay: Arc<UdpSocket>,
    permitted: HashSet<IpAddr>,
    channels: HashMap<u16, SocketAddr>,
    reader: JoinHandle<()>,
}

type Allocations = Arc<Mutex<HashMap<SocketAddr, Allocation>>>;

/// What the server saw, for a test to assert on.
#[derive(Default)]
pub struct Seen {
    /// Allocations made (authenticated Allocate requests answered with a relayed address).
    pub allocations: AtomicUsize,
    /// ChannelData messages a client sent that went on to its peer.
    pub channel_data_out: AtomicUsize,
    /// Datagrams a peer sent to a relayed address that went on to its client (ChannelData or a Data indication).
    pub relayed_in: AtomicUsize,
}

/// The running server; dropped, it stops.
pub struct TurnLab {
    pub addr: SocketAddr,
    pub seen: Arc<Seen>,
    allocations: Allocations,
    server: JoinHandle<()>,
}

impl Drop for TurnLab {
    fn drop(&mut self) {
        self.server.abort();
        for (_, allocation) in self.allocations.lock().unwrap().drain() {
            allocation.reader.abort();
        }
    }
}

/// The attributes of a STUN message, as `(type, value)`; none of a message cut short.
fn attributes(message: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    let end = (20 + u16::from_be_bytes([message[2], message[3]]) as usize).min(message.len());
    let mut at = 20;
    while at + 4 <= end {
        let kind = u16::from_be_bytes([message[at], message[at + 1]]);
        let length = u16::from_be_bytes([message[at + 2], message[at + 3]]) as usize;
        let Some(value) = message.get(at + 4..at + 4 + length) else {
            break;
        };
        out.push((kind, value));
        at += 4 + length.div_ceil(4) * 4;
    }
    out
}

fn attribute<'a>(attributes: &[(u16, &'a [u8])], kind: u16) -> Option<&'a [u8]> {
    attributes.iter().find(|(k, _)| *k == kind).map(|(_, v)| *v)
}

/// A STUN message of type `kind` with the transaction id `id`.
fn message(kind: u16, id: &[u8], attributes: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (kind, value) in attributes {
        body.extend_from_slice(&kind.to_be_bytes());
        body.extend_from_slice(&(value.len() as u16).to_be_bytes());
        body.extend_from_slice(value);
        body.resize(body.len().div_ceil(4) * 4, 0);
    }
    let mut out = Vec::with_capacity(20 + body.len());
    out.extend_from_slice(&kind.to_be_bytes());
    out.extend_from_slice(&(body.len() as u16).to_be_bytes());
    out.extend_from_slice(&COOKIE);
    out.extend_from_slice(id);
    out.extend_from_slice(&body);
    out
}

/// An IPv4 address as an XOR address attribute, and back.
fn xor_address(addr: SocketAddr) -> Vec<u8> {
    let IpAddr::V4(ip) = addr.ip() else {
        panic!("the test TURN server is IPv4 only: {addr}");
    };
    let mut out = vec![0, 1];
    out.extend_from_slice(&(addr.port() ^ 0x2112).to_be_bytes());
    out.extend(
        ip.octets()
            .iter()
            .zip(COOKIE)
            .map(|(byte, mask)| byte ^ mask),
    );
    out
}

fn address(value: &[u8]) -> Option<SocketAddr> {
    if value.len() != 8 || value[1] != 1 {
        return None;
    }
    let port = u16::from_be_bytes([value[2], value[3]]) ^ 0x2112;
    let ip: Vec<u8> = value[4..].iter().zip(COOKIE).map(|(b, m)| b ^ m).collect();
    Some(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])),
        port,
    ))
}

fn channel_data(number: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&number.to_be_bytes());
    out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    out.extend_from_slice(data);
    out
}

/// What a peer sends to a client's relayed address goes on to the client: as ChannelData on the channel bound to
/// that peer, or as a Data indication; dropped from a peer the client did not permit.
async fn relay_in(
    relay: Arc<UdpSocket>,
    server: Arc<UdpSocket>,
    client: SocketAddr,
    allocations: Allocations,
    seen: Arc<Seen>,
) {
    let mut packet = [0u8; 2048];
    let mut indications = 0u64;
    while let Ok((n, peer)) = relay.recv_from(&mut packet).await {
        let channel = {
            let allocations = allocations.lock().unwrap();
            let Some(allocation) = allocations.get(&client) else {
                return;
            };
            if !allocation.permitted.contains(&peer.ip()) {
                continue;
            }
            allocation
                .channels
                .iter()
                .find(|(_, bound)| **bound == peer)
                .map(|(number, _)| *number)
        };
        let out = match channel {
            Some(number) => channel_data(number, &packet[..n]),
            None => {
                indications += 1;
                let mut id = [0u8; 12];
                id[4..].copy_from_slice(&indications.to_be_bytes());
                message(
                    DATA_INDICATION,
                    &id,
                    &[
                        (XOR_PEER_ADDRESS, xor_address(peer)),
                        (DATA, packet[..n].to_vec()),
                    ],
                )
            }
        };
        seen.relayed_in.fetch_add(1, Ordering::Relaxed);
        let _ = server.send_to(&out, client).await;
    }
}

impl TurnLab {
    /// Starts the server on a free UDP port of this machine; it takes the user `username`.
    pub async fn start(username: &'static str) -> TurnLab {
        let server = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let addr = server.local_addr().unwrap();
        let allocations = Allocations::default();
        let seen = Arc::new(Seen::default());
        let task = tokio::spawn(serve(server, username, allocations.clone(), seen.clone()));
        TurnLab {
            addr,
            seen,
            allocations,
            server: task,
        }
    }
}

async fn serve(
    server: Arc<UdpSocket>,
    username: &'static str,
    allocations: Allocations,
    seen: Arc<Seen>,
) {
    let mut packet = [0u8; 2048];
    while let Ok((n, client)) = server.recv_from(&mut packet).await {
        let packet = &packet[..n];
        // ChannelData: a channel number (0x4000 and up), a length, the data.
        if n >= 4 && packet[0] & 0xC0 == 0x40 {
            let number = u16::from_be_bytes([packet[0], packet[1]]);
            let length = u16::from_be_bytes([packet[2], packet[3]]) as usize;
            let to = {
                let allocations = allocations.lock().unwrap();
                allocations.get(&client).and_then(|allocation| {
                    let peer = *allocation.channels.get(&number)?;
                    Some((allocation.relay.clone(), peer))
                })
            };
            if let (Some((relay, peer)), Some(data)) = (to, packet.get(4..4 + length)) {
                seen.channel_data_out.fetch_add(1, Ordering::Relaxed);
                let _ = relay.send_to(data, peer).await;
            }
            continue;
        }
        if n < 20 || packet[0] & 0xC0 != 0 || packet[4..8] != COOKIE {
            continue;
        }
        let kind = u16::from_be_bytes([packet[0], packet[1]]);
        let id = &packet[8..20];
        let attributes = attributes(packet);
        let peer = attribute(&attributes, XOR_PEER_ADDRESS).and_then(address);
        let reply = match kind {
            BINDING => Some(message(
                BINDING | SUCCESS,
                id,
                &[(XOR_MAPPED_ADDRESS, xor_address(client))],
            )),
            // No request goes through without the credentials: the challenge a client answers.
            ALLOCATE | REFRESH | CREATE_PERMISSION | CHANNEL_BIND
                if attribute(&attributes, MESSAGE_INTEGRITY).is_none()
                    || attribute(&attributes, USERNAME) != Some(username.as_bytes()) =>
            {
                Some(message(
                    kind | ERROR,
                    id,
                    &[
                        (ERROR_CODE, [&[0, 0, 4, 1][..], b"Unauthorized"].concat()),
                        (REALM, b"ghostly.test".to_vec()),
                        (NONCE, b"0123456789abcdef".to_vec()),
                    ],
                ))
            }
            ALLOCATE => {
                let known = allocations
                    .lock()
                    .unwrap()
                    .get(&client)
                    .map(|allocation| allocation.relay.clone());
                let relay = match known {
                    Some(relay) => relay,
                    None => {
                        let relay = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
                        let reader = tokio::spawn(relay_in(
                            relay.clone(),
                            server.clone(),
                            client,
                            allocations.clone(),
                            seen.clone(),
                        ));
                        seen.allocations.fetch_add(1, Ordering::Relaxed);
                        allocations.lock().unwrap().insert(
                            client,
                            Allocation {
                                relay: relay.clone(),
                                permitted: HashSet::new(),
                                channels: HashMap::new(),
                                reader,
                            },
                        );
                        relay
                    }
                };
                Some(message(
                    ALLOCATE | SUCCESS,
                    id,
                    &[
                        (
                            XOR_RELAYED_ADDRESS,
                            xor_address(relay.local_addr().unwrap()),
                        ),
                        (LIFETIME, LIFETIME_S.to_be_bytes().to_vec()),
                        (XOR_MAPPED_ADDRESS, xor_address(client)),
                    ],
                ))
            }
            REFRESH => {
                // A lifetime of zero gives the allocation back.
                let wanted = attribute(&attributes, LIFETIME)
                    .and_then(|v| v.try_into().ok())
                    .map(u32::from_be_bytes)
                    .unwrap_or(LIFETIME_S)
                    .min(LIFETIME_S);
                if wanted == 0 {
                    if let Some(allocation) = allocations.lock().unwrap().remove(&client) {
                        allocation.reader.abort();
                    }
                }
                Some(message(
                    REFRESH | SUCCESS,
                    id,
                    &[(LIFETIME, wanted.to_be_bytes().to_vec())],
                ))
            }
            CREATE_PERMISSION | CHANNEL_BIND => {
                let mut allocations = allocations.lock().unwrap();
                let number = attribute(&attributes, CHANNEL_NUMBER)
                    .filter(|v| v.len() == 4)
                    .map(|v| u16::from_be_bytes([v[0], v[1]]));
                match (allocations.get_mut(&client), peer, number) {
                    // 437 Allocation Mismatch without an allocation.
                    (None, _, _) => Some(message(
                        kind | ERROR,
                        id,
                        &[(ERROR_CODE, vec![0, 0, 4, 37])],
                    )),
                    (Some(allocation), Some(_), _) if kind == CREATE_PERMISSION => {
                        let peers = attributes.iter().filter(|(k, _)| *k == XOR_PEER_ADDRESS);
                        allocation
                            .permitted
                            .extend(peers.filter_map(|(_, v)| address(v)).map(|a| a.ip()));
                        Some(message(kind | SUCCESS, id, &[]))
                    }
                    (Some(allocation), Some(peer), Some(number)) => {
                        allocation.permitted.insert(peer.ip());
                        allocation.channels.insert(number, peer);
                        Some(message(kind | SUCCESS, id, &[]))
                    }
                    // 400 Bad Request for one missing its peer or its channel.
                    _ => Some(message(kind | ERROR, id, &[(ERROR_CODE, vec![0, 0, 4, 0])])),
                }
            }
            SEND => {
                let to = {
                    let allocations = allocations.lock().unwrap();
                    allocations
                        .get(&client)
                        .zip(peer)
                        .filter(|(allocation, peer)| allocation.permitted.contains(&peer.ip()))
                        .map(|(allocation, peer)| (allocation.relay.clone(), peer))
                };
                if let (Some((relay, peer)), Some(data)) = (to, attribute(&attributes, DATA)) {
                    let _ = relay.send_to(data, peer).await;
                }
                None
            }
            _ => None,
        };
        if let Some(reply) = reply {
            let _ = server.send_to(&reply, client).await;
        }
    }
}
