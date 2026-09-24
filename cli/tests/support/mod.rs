//! A Pkarr relay held in memory, on the ports set aside for tests (47500-47599):
//! `PUT /<key>` stores a signed packet, `GET /<key>` returns it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct Relay {
    pub url: String,
    pub packets: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

fn listener() -> TcpListener {
    let listener = (47500..=47599)
        .find_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
        .expect("a free port in 47500-47599");
    listener.set_nonblocking(true).unwrap();
    TcpListener::from_std(listener).unwrap()
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let length = head
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buf[end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some((head, body))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

pub async fn relay() -> Relay {
    let listener = listener();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let packets = Arc::new(Mutex::new(HashMap::<String, Vec<u8>>::new()));
    let store = packets.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let store = store.clone();
            tokio::spawn(async move {
                let Some((head, body)) = read_request(&mut stream).await else {
                    return;
                };
                let mut line = head.lines().next().unwrap_or("").split(' ');
                let (method, target) = (line.next().unwrap_or(""), line.next().unwrap_or(""));
                let key = target
                    .trim_start_matches('/')
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .to_string();
                if method == "PUT" {
                    store.lock().unwrap().insert(key, body);
                    respond(&mut stream, "200 OK", b"").await;
                    return;
                }
                let packet = store.lock().unwrap().get(&key).cloned();
                match packet {
                    Some(packet) => respond(&mut stream, "200 OK", &packet).await,
                    None => respond(&mut stream, "404 Not Found", b"").await,
                }
            });
        }
    });
    Relay { url, packets }
}

/// A Pkarr client that only talks to `relay`.
pub fn client(relay: &Relay) -> pkarr::Client {
    let mut builder = pkarr::Client::builder();
    builder.no_default_network();
    builder.relays(&[relay.url.as_str()]).unwrap();
    builder.build().unwrap()
}
