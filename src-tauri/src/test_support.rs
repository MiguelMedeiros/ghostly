//! What the tests share: servers on the ports set aside for them (47500-47599,
//! so they never meet anything else running on this machine), a minimal HTTP
//! exchange, and a Pkarr relay held in memory.

use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const PORTS: std::ops::RangeInclusive<u16> = 47500..=47599;

/// A listener on 127.0.0.1, on the first free port of the range.
pub fn listener() -> TcpListener {
    PORTS
        .into_iter()
        .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
        .expect("a free port in 47500-47599")
}

/// The same, for a tokio server. Call it inside a runtime.
pub fn tokio_listener() -> tokio::net::TcpListener {
    let listener = listener();
    listener.set_nonblocking(true).unwrap();
    tokio::net::TcpListener::from_std(listener).unwrap()
}

/// A port of the range nothing listens on. Taken from the top, away from the
/// ones `listener` hands out first.
pub fn closed_port() -> u16 {
    PORTS
        .rev()
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .expect("a free port in 47500-47599")
}

/// The requests a test server saw: each one's head and body.
pub type Requests = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// One HTTP/1.1 request: its head (request line and headers) and its body, read
/// by Content-Length.
pub async fn read_request<S: AsyncRead + Unpin>(stream: &mut S) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
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
    body.truncate(length);
    Some((head, body))
}

/// Writes a whole response and closes the connection.
pub async fn respond<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

/// A Pkarr relay that keeps what is published in memory: `PUT /<key>` stores
/// the signed packet, `GET /<key>` returns it. Enough for the Pkarr client,
/// with no DHT and no network.
pub struct Relay {
    pub url: String,
    pub packets: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    /// Every request's method and path, in order (a PUT with `If-Match` says so: `PUT /key if-match=<ts>`).
    pub requests: Arc<Mutex<Vec<String>>>,
    /// How long it takes to answer a GET, the way the DHT takes its time.
    pub delay: Arc<Mutex<std::time::Duration>>,
    /// Headers added to every answer (`x-ratelimit-remaining`, as the public relays say).
    pub headers: Arc<Mutex<Vec<(String, String)>>>,
    /// The relay is still putting the packet it holds on the DHT: a PUT replacing it must name it
    /// (`If-Match`, 428 otherwise), as the public relays do.
    pub putting: Arc<Mutex<bool>>,
    /// The relay is broken: every request gets a 503.
    pub broken: Arc<Mutex<bool>>,
}

/// The timestamp of a relay payload (bytes 64..72, microseconds, big-endian).
fn payload_timestamp(payload: &[u8]) -> Option<u64> {
    payload
        .get(64..72)
        .map(|b| u64::from_be_bytes(b.try_into().unwrap()))
}

pub async fn pkarr_relay() -> Relay {
    let listener = tokio_listener();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let packets = Arc::new(Mutex::new(HashMap::<String, Vec<u8>>::new()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let delay = Arc::new(Mutex::new(std::time::Duration::ZERO));
    let headers = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let putting = Arc::new(Mutex::new(false));
    let broken = Arc::new(Mutex::new(false));
    let (store, seen, slow, extra, busy, down) = (
        packets.clone(),
        requests.clone(),
        delay.clone(),
        headers.clone(),
        putting.clone(),
        broken.clone(),
    );
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let (store, seen, slow, extra, busy, down) = (
                store.clone(),
                seen.clone(),
                slow.clone(),
                extra.clone(),
                busy.clone(),
                down.clone(),
            );
            tokio::spawn(async move {
                let Some((head, body)) = read_request(&mut stream).await else {
                    return;
                };
                let mut request = head.lines().next().unwrap_or("").split(' ');
                let (method, target) = (request.next().unwrap_or(""), request.next().unwrap_or(""));
                let if_match = head
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.trim().eq_ignore_ascii_case("if-match"))
                    .and_then(|(_, value)| value.trim().parse::<u64>().ok());
                seen.lock().unwrap().push(match if_match {
                    Some(ts) => format!("{method} {target} if-match={ts}"),
                    None => format!("{method} {target}"),
                });
                let key = target
                    .trim_start_matches('/')
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .to_string();
                let extra: Vec<(String, String)> = extra.lock().unwrap().clone();
                let extra: Vec<(&str, &str)> = extra
                    .iter()
                    .map(|(n, v)| (n.as_str(), v.as_str()))
                    .collect();
                if *down.lock().unwrap() {
                    return respond(&mut stream, "503 Service Unavailable", &extra, b"").await;
                }
                match method {
                    "PUT" => {
                        let held = store
                            .lock()
                            .unwrap()
                            .get(&key)
                            .and_then(|p| payload_timestamp(p));
                        let incoming = payload_timestamp(&body);
                        let status = match (held, if_match, *busy.lock().unwrap()) {
                            // Older than what it holds: never.
                            (Some(held), _, _) if incoming.is_some_and(|ts| ts <= held) => {
                                "409 Conflict"
                            }
                            (Some(_), None, true) => "428 Precondition Required",
                            (held, Some(named), _) if held != Some(named) => {
                                "412 Precondition Failed"
                            }
                            _ => "200 OK",
                        };
                        if status.starts_with("200") {
                            store.lock().unwrap().insert(key, body);
                        }
                        respond(&mut stream, status, &extra, b"").await;
                    }
                    "GET" => {
                        let delay = *slow.lock().unwrap();
                        tokio::time::sleep(delay).await;
                        let packet = store.lock().unwrap().get(&key).cloned();
                        match packet {
                            Some(packet) => {
                                let mut headers =
                                    vec![("Content-Type", "application/pkarr.org/relays#payload")];
                                headers.extend(extra.iter().copied());
                                respond(&mut stream, "200 OK", &headers, &packet).await
                            }
                            None => respond(&mut stream, "404 Not Found", &extra, b"").await,
                        }
                    }
                    _ => respond(&mut stream, "405 Method Not Allowed", &[], b"").await,
                }
            });
        }
    });
    Relay {
        url,
        packets,
        requests,
        delay,
        headers,
        putting,
        broken,
    }
}

/// Desktop's Pkarr with `relay` as its only relay and no DHT.
pub fn pkarr(relay: &Relay) -> crate::pkarr_network::Pkarr {
    crate::pkarr_network::Pkarr::new(None, &[relay.url.parse().unwrap()]).unwrap()
}

/// A Pkarr client that only talks to `relay`.
pub fn pkarr_client(relay: &Relay) -> pkarr::Client {
    let mut builder = pkarr::Client::builder();
    builder.no_default_network();
    builder.relays(&[relay.url.as_str()]).unwrap();
    builder.build().unwrap()
}
