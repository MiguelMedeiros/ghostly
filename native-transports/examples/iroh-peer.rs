//! Headless local interoperability peer. JSON lines on stdin/stdout are a test
//! bridge only; all peer traffic uses the real Iroh QUIC connection.
use ghostly_transports::iroh_transport as wire;
use iroh::{endpoint::Connection, Endpoint};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::{mpsc, Mutex},
};
type Sockets = Arc<Mutex<HashMap<u64, (Connection, mpsc::Sender<String>)>>>;
async fn attach(
    endpoint: Endpoint,
    conn: Connection,
    incoming: bool,
    sockets: Sockets,
    next: Arc<AtomicU64>,
) -> Result<(), String> {
    let binding = wire::binding(&endpoint, &conn)?;
    let (mut send, mut recv) = if incoming {
        let (send, mut recv) = conn.accept_bi().await.map_err(|e| e.to_string())?;
        if wire::read_frame(&mut recv).await? != b"ghostly/paired-chat/1" {
            return Err("Bad preface".into());
        }
        (send, recv)
    } else {
        let (mut send, recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        wire::write_frame(&mut send, b"ghostly/paired-chat/1").await?;
        (send, recv)
    };
    let id = next.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<String>(32);
    sockets.lock().await.insert(id, (conn.clone(), tx));
    println!("{}", json!({"type":"open", "id":id,"binding":binding}));
    tokio::spawn(async move {
        tokio::select! {
            _ = async { while let Some(text) = rx.recv().await { wire::write_frame(&mut send, text.as_bytes()).await?; } Ok::<(),String>(()) } => {},
            _ = async { loop { let frame = wire::read_frame(&mut recv).await?; let text = String::from_utf8(frame).map_err(|e| e.to_string())?; println!("{}", json!({"type":"frame","id":id,"text":text})); } #[allow(unreachable_code)] Ok::<(),String>(()) } => {},
            _ = conn.closed() => {},
        }
        sockets.lock().await.remove(&id);
        conn.close(0u32.into(), b"closed");
        println!("{}", json!({"type":"closed","id":id}));
    });
    Ok(())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let init: Value = serde_json::from_str(&lines.next_line().await?.ok_or("Missing init")?)?;
    let seed: [u8; 32] = serde_json::from_value(init["seed"].clone())?;
    // `relays` homes the peer on those relays (a browser peer can only reach
    // it there); without it the peer stays on loopback.
    let relays: Option<Vec<String>> = serde_json::from_value(init["relays"].clone())?;
    let endpoint = match relays {
        Some(relays) => {
            let endpoint = wire::endpoint_with_relays(seed, &relays).await?;
            endpoint.online().await;
            endpoint
        }
        None => wire::endpoint(seed, true).await?,
    };
    let sockets: Sockets = Arc::default();
    let next = Arc::new(AtomicU64::new(1));
    println!(
        "{}",
        json!({"type":"address","descriptor":wire::address(&endpoint)})
    );
    let accept_endpoint = endpoint.clone();
    let accept_sockets = sockets.clone();
    let accept_next = next.clone();
    let accept = tokio::spawn(async move {
        while let Some(incoming) = accept_endpoint.accept().await {
            if let Ok(conn) = incoming.await {
                let _ = attach(
                    accept_endpoint.clone(),
                    conn,
                    true,
                    accept_sockets.clone(),
                    accept_next.clone(),
                )
                .await;
            }
        }
    });
    while let Some(line) = lines.next_line().await? {
        if line.len() > 256 * 1024 {
            break;
        }
        let message: Value = serde_json::from_str(&line)?;
        match message["type"].as_str() {
            Some("connect") => {
                let descriptor = serde_json::from_value(message["descriptor"].clone())?;
                let conn = wire::connect(&endpoint, &descriptor).await?;
                attach(endpoint.clone(), conn, false, sockets.clone(), next.clone()).await?;
            }
            Some("send") => {
                let id = message["id"].as_u64().ok_or("Invalid ID")?;
                let text = message["text"].as_str().ok_or("Invalid text")?;
                if let Some((_, tx)) = sockets.lock().await.get(&id) {
                    tx.try_send(text.into())?;
                }
            }
            Some("close") => {
                if let Some((conn, _)) = sockets
                    .lock()
                    .await
                    .remove(&message["id"].as_u64().unwrap_or(0))
                {
                    conn.close(0u32.into(), b"reconnect");
                }
            }
            _ => break,
        }
    }
    accept.abort();
    endpoint.close().await;
    Ok(())
}
