use iroh::{
    endpoint::{presets, Connection},
    Endpoint, EndpointAddr, SecretKey,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, time::Duration};

pub const ALPN: &[u8] = b"ghostly/paired-chat/1";
pub const MAX_FRAME: usize = 60 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
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

pub async fn endpoint(seed: [u8; 32], local_only: bool) -> Result<Endpoint, String> {
    let builder = if local_only {
        Endpoint::builder(presets::Minimal)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .map_err(|e| e.to_string())?
    } else {
        Endpoint::builder(presets::N0)
    };
    builder
        .secret_key(SecretKey::from_bytes(&seed))
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| e.to_string())
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
}
