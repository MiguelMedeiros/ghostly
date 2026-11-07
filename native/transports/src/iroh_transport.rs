use iroh::{
    dns::DnsResolver,
    endpoint::{presets, Connection, QuicTransportConfig, VarInt},
    Endpoint, EndpointAddr, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, time::Duration};

pub const ALPN: &[u8] = b"ghostly/paired-chat/1";
pub const MAX_FRAME: usize = 60 * 1024;
/// Bytes a contact may send on the chat's stream before this side confirms them. QUIC's default, 1.25 MB, is sized
/// for 100 ms: a file is about 1.37 bytes on the stream per byte of it (base64url text), so at 150 ms it carried 5.25 MiB/s
/// on a 100 Mbit path. 4 MiB is more than a chat's files have in flight (`chatWindowBytes`, 2 MiB, as text).
pub const STREAM_WINDOW: u32 = 4 * 1024 * 1024;
/// Bytes a contact may send on all of a connection's streams before this side confirms them: QUIC's default has no
/// bound, so each stream the contact opened and nobody here reads could hold a window of its own.
pub const CONNECTION_WINDOW: u32 = 2 * STREAM_WINDOW;

fn transport() -> QuicTransportConfig {
    QuicTransportConfig::builder()
        .stream_receive_window(VarInt::from_u32(STREAM_WINDOW))
        .receive_window(VarInt::from_u32(CONNECTION_WINDOW))
        .build()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Address {
    pub id: String,
    pub relay: Option<String>,
    pub addresses: Vec<String>,
}

/// A fresh TLS exporter binds participation proofs to this exact authenticated
/// QUIC handshake, never to a user-supplied string pretending to be DTLS.
#[derive(Debug, Clone, Serialize)]
pub struct Binding {
    pub transport: &'static str,
    pub context: String,
    pub identities: [String; 2],
}

pub fn binding(endpoint: &Endpoint, connection: &Connection) -> Result<Binding, String> {
    if connection.alpn() != ALPN {
        return Err("Unexpected Iroh ALPN".into());
    }
    let mut context = [0u8; 32];
    connection
        .export_keying_material(&mut context, b"EXPORTER-Ghostly-paired-chat-v1", ALPN)
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Ghostly's own Iroh relay (`iroh-relay` 1.3 behind a Cloudflare tunnel), one more to home on after n0's. Its plain
/// name: the tunnel finds it by the Host header and answers the dotted one with 404.
pub const GHOSTLY_RELAY: &str = "https://iroh.miguelmedeiros.dev/";

/// The relays an endpoint homes on when none are set: n0's four, then Ghostly's. Iroh homes on the one with the lowest
/// latency it measures, so a relay out of reach is passed over. Ghostly's has no QUIC address discovery (its UDP does
/// not cross the tunnel): it relays only.
pub fn default_relays() -> RelayMap {
    let relays = iroh::defaults::prod::default_relay_map();
    let ours: RelayUrl = GHOSTLY_RELAY.parse().expect("Ghostly's relay URL");
    relays.insert(ours.clone(), std::sync::Arc::new(RelayConfig::new(ours, None)));
    relays
}

/// `dns`, when given, is what the endpoint resolves names with (relays among them) instead of the system's.
pub async fn endpoint(
    seed: [u8; 32],
    local_only: bool,
    dns: Option<DnsResolver>,
) -> Result<Endpoint, String> {
    let builder = if local_only {
        Endpoint::builder(presets::Minimal)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .map_err(|e| e.to_string())?
    } else {
        Endpoint::builder(presets::N0).relay_mode(RelayMode::Custom(default_relays()))
    };
    let builder = match dns {
        Some(dns) => builder.dns_resolver(dns),
        None => builder,
    };
    builder
        .secret_key(SecretKey::from_bytes(&seed))
        .alpns(vec![ALPN.to_vec()])
        .transport_config(transport())
        .bind()
        .await
        .map_err(|e| e.to_string())
}

/// An endpoint homed on the given relays instead of n0's defaults: a
/// self-hosted `iroh-relay`, or the e2e one. Direct paths are kept, so two
/// native peers still hole-punch; a browser peer reaches it through the relay. `dns` as in `endpoint`.
pub async fn endpoint_with_relays(
    seed: [u8; 32],
    relays: &[String],
    dns: Option<DnsResolver>,
) -> Result<Endpoint, String> {
    let builder =
        Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Custom(relay_map(relays)?));
    let builder = match dns {
        Some(dns) => builder.dns_resolver(dns),
        None => builder,
    };
    builder
        .secret_key(SecretKey::from_bytes(&seed))
        .alpns(vec![ALPN.to_vec()])
        .transport_config(transport())
        .bind()
        .await
        .map_err(|e| e.to_string())
}

/// The relays an endpoint is given, parsed: one to five, as many as the browser build (`iroh-web`) takes, so the
/// Desktop homes on any list Settings, Network accepts.
fn relay_urls(relays: &[String]) -> Result<Vec<RelayUrl>, String> {
    if relays.is_empty() || relays.len() > 5 {
        return Err("Between one and five relays are needed".into());
    }
    relays
        .iter()
        .map(|url| url.parse::<RelayUrl>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Invalid Iroh relay URL".into())
}

/// The relays given, and which of them to ask for this endpoint's public address (QUIC address discovery, UDP 7842):
/// n0's alone. Iroh homes on a relay only once each one asked has answered or waited 3 s, so on a relay that offers
/// none every listener took 3 s to start. `iroh-relay` offers none unless set to, and never without TLS; Ghostly's
/// cannot through its tunnel (`default_relays`).
fn relay_map(relays: &[String]) -> Result<RelayMap, String> {
    Ok(RelayMap::from_iter(relay_urls(relays)?.into_iter().map(
        |url| {
            let n0 = url
                .host_str()
                .is_some_and(|host| host.trim_end_matches('.').ends_with(".iroh.link"));
            let quic = RelayConfig::from(url.clone()).quic.filter(|_| n0);
            RelayConfig::new(url, quic)
        },
    )))
}

pub fn address(endpoint: &Endpoint) -> Address {
    let addr = endpoint.addr();
    let mut addresses: Vec<_> = addr.ip_addrs().copied().collect();
    // A multihomed Mac can expose many IPv6 addresses. Keep a bounded set,
    // preferring IPv4 so temporary IPv6 addresses cannot crowd out the LAN route.
    addresses.sort_by_key(|ip| (!ip.is_ipv4(), ip.to_string()));
    addresses.dedup();
    addresses.truncate(8);
    let result = Address {
        id: endpoint.id().to_string(),
        relay: addr.relay_urls().next().map(ToString::to_string),
        addresses: addresses.iter().map(ToString::to_string).collect(),
    };
    result
}

pub async fn connect(endpoint: &Endpoint, address: &Address) -> Result<Connection, String> {
    if address.addresses.len() > 8 {
        return Err("Too many endpoint addresses".into());
    }
    let id = address.id.parse().map_err(|_| "Invalid Iroh endpoint ID")?;
    let mut addr = EndpointAddr::new(id);
    if let Some(relay) = &address.relay {
        addr = addr.with_relay_url(relay.parse().map_err(|_| "Invalid Iroh relay URL")?);
    }
    for ip in &address.addresses {
        addr = addr.with_ip_addr(
            ip.parse::<SocketAddr>()
                .map_err(|_| "Invalid endpoint address")?,
        );
    }
    tokio::time::timeout(Duration::from_secs(20), endpoint.connect(addr, ALPN))
        .await
        .map_err(|_| "Iroh connection timed out")?
        .map_err(|e| e.to_string())
}

pub async fn write_frame(
    send: &mut iroh::endpoint::SendStream,
    frame: &[u8],
) -> Result<(), String> {
    if frame.is_empty() || frame.len() > MAX_FRAME {
        return Err("Frame exceeds transport budget".into());
    }
    send.write_all(&(frame.len() as u32).to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    send.write_all(frame).await.map_err(|e| e.to_string())
}

pub async fn read_frame(recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<u8>, String> {
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

#[cfg(test)]
mod tests {
    // covers: transport.iroh
    use super::*;
    #[test]
    fn takes_one_to_five_relays() {
        let relays: Vec<String> = (0..6)
            .map(|i| format!("http://127.0.0.1:{}/", 3340 + i))
            .collect();
        // n0's four plus Ghostly's own: the browser build's defaults, which Settings can hand the Desktop.
        assert_eq!(relay_urls(&relays[..5]).map(|urls| urls.len()), Ok(5));
        assert_eq!(relay_urls(&relays[..1]).map(|urls| urls.len()), Ok(1));
        for wrong in [&relays[..0], &relays[..]] {
            assert_eq!(
                relay_urls(wrong),
                Err("Between one and five relays are needed".to_string())
            );
        }
        assert_eq!(
            relay_urls(&["not a relay".to_string()]),
            Err("Invalid Iroh relay URL".to_string())
        );
    }
    #[tokio::test]
    async fn real_quic_frames_exporter_and_reconnect() {
        let a = endpoint([1; 32], true).await.unwrap();
        let b = endpoint([2; 32], true).await.unwrap();
        let mut contexts = Vec::new();
        for _ in 0..2 {
            let addr = address(&b);
            let (outgoing, incoming) = tokio::time::timeout(Duration::from_secs(25), async {
                tokio::join!(connect(&a, &addr), async {
                    b.accept().await.unwrap().await.unwrap()
                })
            })
            .await
            .expect("real QUIC connection within test deadline");
            let outgoing = outgoing.unwrap();
            let left = binding(&a, &outgoing).unwrap();
            let right = binding(&b, &incoming).unwrap();
            assert_eq!(left.context, right.context);
            assert_eq!(left.identities, right.identities);
            contexts.push(left.context);
            let (mut tx, mut rx) = outgoing.open_bi().await.unwrap();
            assert!(write_frame(&mut tx, b"").await.is_err());
            assert!(write_frame(&mut tx, &vec![0; MAX_FRAME + 1]).await.is_err());
            write_frame(&mut tx, b"real request").await.unwrap();
            let (mut tx_b, mut rx_b) = incoming.accept_bi().await.unwrap();
            assert_eq!(read_frame(&mut rx_b).await.unwrap(), b"real request");
            write_frame(&mut tx_b, b"real receipt").await.unwrap();
            assert_eq!(read_frame(&mut rx).await.unwrap(), b"real receipt");
            outgoing.close(0u32.into(), b"reconnect test");
            incoming.close(0u32.into(), b"reconnect test");
        }
        assert_ne!(contexts[0], contexts[1]);
        a.close().await;
        b.close().await;
    }

    #[test]
    fn default_relays_are_n0s_then_ghostlys_without_quic() {
        let relays = default_relays();
        let urls: Vec<String> = relays
            .urls::<Vec<RelayUrl>>()
            .iter()
            .map(ToString::to_string)
            .collect();
        for n0 in ["use1-1", "usw1-1", "euc1-1", "aps1-1"] {
            let url = format!("https://{n0}.relay.n0.iroh.link./");
            assert!(urls.contains(&url), "{url} kept in {urls:?}");
        }
        assert_eq!(urls.len(), 5);
        // Plain: the tunnel in front of it answers the dotted name with 404.
        let ours: RelayUrl = "https://iroh.miguelmedeiros.dev/".parse().unwrap();
        let config = relays.get(&ours).expect("Ghostly's relay, plain name");
        assert_eq!(config.quic, None, "no QUIC address discovery through the tunnel");
    }

    /// Iroh homes on a relay only once its address discovery has answered or waited 3 s: a listener on a relay that
    /// offers none (Ghostly's, a lab one) took 3 s to start. Only n0's relays are asked.
    #[test]
    fn set_relays_ask_only_n0s_for_their_address() {
        let relays: Vec<String> = [
            "https://use1-1.relay.n0.iroh.link./",
            "https://euc1-1.relay.n0.iroh.link/",
            "https://iroh.miguelmedeiros.dev/",
            "https://relay.example.com/",
            "http://127.0.0.1:4980/",
        ]
        .map(String::from)
        .to_vec();
        let map = relay_map(&relays).unwrap();
        let asked: Vec<bool> = relays
            .iter()
            .map(|url| map.get(&url.parse().unwrap()).unwrap().quic.is_some())
            .collect();
        assert_eq!(asked, [true, true, false, false, false]);
    }
}

/// What a peer can get wrong: addresses, frame lengths, the protocol it speaks.
#[cfg(test)]
mod limits {
    use super::*;

    async fn pair(alpn: &[u8]) -> (Endpoint, Endpoint, Connection, Connection) {
        let bind = |seed: u8| {
            let alpn = alpn.to_vec();
            async move {
                Endpoint::builder(presets::Minimal)
                    .clear_ip_transports()
                    .bind_addr("127.0.0.1:0")
                    .unwrap()
                    .secret_key(SecretKey::from_bytes(&[seed; 32]))
                    .alpns(vec![alpn])
                    .bind()
                    .await
                    .unwrap()
            }
        };
        let (a, b) = (bind(11).await, bind(12).await);
        let addr = b.addr();
        let (outgoing, incoming) = tokio::time::timeout(Duration::from_secs(25), async {
            tokio::join!(a.connect(addr, alpn), async {
                b.accept().await.unwrap().await.unwrap()
            })
        })
        .await
        .unwrap();
        (a, b, outgoing.unwrap(), incoming)
    }

    #[tokio::test]
    async fn refuses_an_address_it_cannot_use_before_dialling() {
        let a = endpoint([21; 32], true).await.unwrap();
        let good = address(&endpoint([22; 32], true).await.unwrap());
        assert_eq!(good.relay, None, "a local endpoint has no relay");
        assert!(!good.addresses.is_empty() && good.addresses.len() <= 8);
        assert!(good.addresses.iter().all(|a| a.starts_with("127.0.0.1:")));

        let mut many = good.clone();
        many.addresses = (0..9).map(|i| format!("127.0.0.1:{}", 47500 + i)).collect();
        assert_eq!(
            connect(&a, &many).await.unwrap_err(),
            "Too many endpoint addresses"
        );
        let mut bad = good.clone();
        bad.id = "not an id".into();
        assert_eq!(
            connect(&a, &bad).await.unwrap_err(),
            "Invalid Iroh endpoint ID"
        );
        let mut bad = good.clone();
        bad.relay = Some("not a url".into());
        assert_eq!(
            connect(&a, &bad).await.unwrap_err(),
            "Invalid Iroh relay URL"
        );
        let mut bad = good.clone();
        bad.addresses = vec!["127.0.0.1".into()];
        assert_eq!(
            connect(&a, &bad).await.unwrap_err(),
            "Invalid endpoint address"
        );
        a.close().await;
    }

    #[tokio::test]
    async fn frame_lengths_outside_the_budget_or_cut_short_are_errors() {
        let (a, b, outgoing, incoming) = pair(ALPN).await;
        for header in [0u32, MAX_FRAME as u32 + 1, u32::MAX] {
            let (mut tx, _rx) = outgoing.open_bi().await.unwrap();
            tx.write_all(&header.to_be_bytes()).await.unwrap();
            tx.write_all(b"payload").await.unwrap();
            let (_tx_b, mut rx_b) = incoming.accept_bi().await.unwrap();
            assert_eq!(
                read_frame(&mut rx_b).await.unwrap_err(),
                "Frame exceeds transport budget",
                "{header}"
            );
        }
        // Announces ten bytes, sends five and finishes the stream.
        let (mut tx, _rx) = outgoing.open_bi().await.unwrap();
        tx.write_all(&10u32.to_be_bytes()).await.unwrap();
        tx.write_all(b"12345").await.unwrap();
        tx.finish().unwrap();
        let (_tx_b, mut rx_b) = incoming.accept_bi().await.unwrap();
        assert!(read_frame(&mut rx_b).await.is_err());
        a.close().await;
        b.close().await;
    }

    #[tokio::test]
    async fn a_connection_for_another_protocol_has_no_binding() {
        let (a, b, outgoing, incoming) = pair(b"someone-else/1").await;
        assert_eq!(binding(&a, &outgoing).unwrap_err(), "Unexpected Iroh ALPN");
        assert_eq!(binding(&b, &incoming).unwrap_err(), "Unexpected Iroh ALPN");
        a.close().await;
        b.close().await;
    }

    /// What a contact may send before this side confirms it: a chat's files in flight on the chat's stream (QUIC's
    /// 1.25 MB held a file at 5.25 MiB/s on a 150 ms path), and no more than two such windows over all its streams.
    #[tokio::test]
    async fn a_contact_may_have_a_chats_files_in_flight_on_its_stream_and_no_more_in_all() {
        let a = endpoint([13; 32], true).await.unwrap();
        let b = endpoint([14; 32], true).await.unwrap();
        let addr = address(&b);
        let (outgoing, incoming) = tokio::time::timeout(Duration::from_secs(25), async {
            tokio::join!(connect(&a, &addr), async {
                b.accept().await.unwrap().await.unwrap()
            })
        })
        .await
        .unwrap();
        let outgoing = outgoing.unwrap();
        // Nothing is read on b: a write finishes only as far as b lets a have bytes unconfirmed.
        let write = |bytes: usize| {
            let outgoing = outgoing.clone();
            async move {
                let (mut send, _recv) = outgoing.open_bi().await.unwrap();
                let written =
                    tokio::time::timeout(Duration::from_secs(3), send.write_all(&vec![7; bytes]))
                        .await;
                (written.is_ok(), send)
            }
        };
        let window = STREAM_WINDOW as usize;
        let (whole, _first) = write(3 * 1024 * 1024).await;
        assert!(whole, "3 MiB in flight on one stream");
        let (rest, _second) = write(window - 3 * 1024 * 1024).await;
        assert!(rest, "the rest of a window on another stream");
        let (third, _third) = write(window).await;
        assert!(third, "a third stream up to the connection's bound");
        let (past, _past) = write(64 * 1024).await;
        assert!(!past, "past two windows over all streams, a contact waits");
        drop(incoming);
        a.close().await;
        b.close().await;
    }
}
