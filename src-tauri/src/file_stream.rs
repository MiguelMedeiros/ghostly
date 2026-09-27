//! A stored file played in place (`<video>`, `<audio>`) without the page holding it: the `ghostly-file` scheme
//! serves a file of the store (`file_store.rs`) in ranges, the way a web server serves a video.
//!
//! The page asks for a file with `file_bytes_stream_open` and gets a token: 32 random bytes, new each time, known
//! only to this run of the app. The URL is `ghostly-file://localhost/<token>` (`http://ghostly-file.localhost/<token>`
//! on Windows). The token stands for one file of one profile's folder, checked when it was given; nothing in a URL is
//! ever read as a path, and there is nothing to list. Only the Ghostly window is answered: a window showing a
//! contact's app (`viewer.rs`) reaches the scheme too, and gets 404 whatever it asks.
//!
//! Linux's WebKitGTK plays media from `http(s)` and `blob:` only, so there the same tokens are served over HTTP on
//! 127.0.0.1 (`loopback`); `file_bytes_stream_open` gives the page the URL for its platform.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::SysRng;
use rand::TryRng;
use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::file_store::FileStore;

pub const SCHEME: &str = "ghostly-file";

/// The most one answer carries. The engines ask again from where it stopped, so a file of any size plays while
/// only this much of it is in memory per request.
pub const MAX_BODY: u64 = 4 * 1024 * 1024;
/// A request with no range gets the whole file up to this size; above it, the first `MAX_BODY` as a range.
pub const WHOLE_MAX: u64 = 16 * 1024 * 1024;
/// Files open for playing at once: a new one past this closes the oldest.
pub const MAX_GRANTS: usize = 16;

/// The types a file is served as: what `<video>` and `<audio>` play. Anything else goes out as opaque bytes.
const MEDIA_TYPES: &[&str] = &[
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
    "video/x-m4v",
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
    "audio/aac",
    "audio/wav",
    "audio/x-m4a",
    "audio/flac",
];

struct Grant {
    space: String,
    id: String,
    mime: &'static str,
    /// When it was given, to close the oldest first.
    serial: u64,
}

/// The tokens given out, shared by the scheme's handler and (Linux) the loopback server's threads.
#[derive(Default, Clone)]
pub struct StreamGrants {
    grants: Arc<Mutex<HashMap<String, Grant>>>,
    next: Arc<AtomicU64>,
    loopback: Arc<Mutex<Option<u16>>>,
}

impl StreamGrants {
    /// A token for this file, which must exist in the store.
    pub fn open(
        &self,
        store: &FileStore,
        space: &str,
        id: &str,
        mime: &str,
    ) -> Result<String, String> {
        if store.size(space, id)?.is_none() {
            return Err("No such file".into());
        }
        let mut raw = [0u8; 32];
        SysRng.try_fill_bytes(&mut raw).map_err(|e| e.to_string())?;
        let token = URL_SAFE_NO_PAD.encode(raw);
        let serial = self.next.fetch_add(1, Ordering::Relaxed);
        let mut grants = self.grants.lock().unwrap();
        while grants.len() >= MAX_GRANTS {
            let oldest = grants
                .iter()
                .min_by_key(|(_, grant)| grant.serial)
                .map(|(token, _)| token.clone());
            match oldest {
                Some(oldest) => grants.remove(&oldest),
                None => break,
            };
        }
        grants.insert(
            token.clone(),
            Grant {
                space: space.to_string(),
                id: id.to_string(),
                mime: media_type(mime),
                serial,
            },
        );
        Ok(token)
    }

    /// The loopback server's port, started on first use.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn loopback_port(&self, store: &FileStore) -> Result<u16, String> {
        let mut port = self.loopback.lock().unwrap();
        if let Some(port) = *port {
            return Ok(port);
        }
        let started = loopback::start(store.clone(), self.clone())?;
        *port = Some(started);
        Ok(started)
    }

    pub fn close(&self, token: &str) {
        self.grants.lock().unwrap().remove(token);
    }

    /// Every token of a profile goes when its files do (a deleted profile, a cleared chat).
    pub fn close_space(&self, space: &str) {
        self.grants
            .lock()
            .unwrap()
            .retain(|_, grant| grant.space != space);
    }

    fn lookup(&self, token: &str) -> Option<(String, String, &'static str)> {
        self.grants
            .lock()
            .unwrap()
            .get(token)
            .map(|grant| (grant.space.clone(), grant.id.clone(), grant.mime))
    }
}

fn media_type(mime: &str) -> &'static str {
    let essence = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    MEDIA_TYPES
        .iter()
        .find(|known| **known == essence)
        .copied()
        .unwrap_or("application/octet-stream")
}

/// A byte range asked for, as the first and last byte (both included), or why it cannot be served.
#[derive(Debug, PartialEq, Eq)]
pub enum Range {
    /// No range, or one this server does not read (another unit): the whole file.
    Whole,
    Bytes(u64, u64),
    Unsatisfiable,
}

/// Reads a `Range` header against a file of `size` bytes. Only the first of several ranges is served.
pub fn parse_range(value: Option<&str>, size: u64) -> Range {
    let Some(value) = value.map(str::trim) else {
        return Range::Whole;
    };
    let Some(spec) = value.strip_prefix("bytes=") else {
        return Range::Whole;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((start, end)) = first.split_once('-') else {
        return Range::Unsatisfiable;
    };
    let (start, end) = (start.trim(), end.trim());
    let number = |text: &str| -> Option<u64> {
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            text.parse().ok()
        }
    };
    if start.is_empty() {
        // The last n bytes.
        return match number(end) {
            Some(0) | None => Range::Unsatisfiable,
            Some(_) if size == 0 => Range::Unsatisfiable,
            Some(n) => Range::Bytes(size.saturating_sub(n), size - 1),
        };
    }
    let Some(start) = number(start) else {
        return Range::Unsatisfiable;
    };
    if start >= size {
        return Range::Unsatisfiable;
    }
    if end.is_empty() {
        return Range::Bytes(start, size - 1);
    }
    match number(end) {
        Some(end) if end >= start => Range::Bytes(start, end.min(size - 1)),
        _ => Range::Unsatisfiable,
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap()
}

/// What to answer a request with: its status and headers, and which bytes of which file follow them.
struct Plan {
    status: StatusCode,
    headers: Vec<(header::HeaderName, String)>,
    body: Option<(File, u64, u64)>,
}

impl Plan {
    fn bare(status: StatusCode) -> Self {
        Plan {
            status,
            headers: vec![(header::CACHE_CONTROL, "no-store".into())],
            body: None,
        }
    }
}

/// The answer to a request for `path` (`/<token>`, nothing else). `cap` bounds a body that is read into memory (the
/// scheme's); without it (the loopback server's, which streams) a range goes to its end.
fn plan(
    store: &FileStore,
    grants: &StreamGrants,
    method: &Method,
    path: &str,
    asked: Option<&str>,
    cap: Option<u64>,
) -> Plan {
    let head = method == Method::HEAD;
    if !head && method != Method::GET {
        return Plan::bare(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(token) = path.strip_prefix('/') else {
        return Plan::bare(StatusCode::NOT_FOUND);
    };
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Plan::bare(StatusCode::NOT_FOUND);
    }
    let Some((space, id, mime)) = grants.lookup(token) else {
        return Plan::bare(StatusCode::NOT_FOUND);
    };
    let Ok(file) = store
        .path_of(&space, &id)
        .and_then(|path| File::open(path).map_err(|e| e.to_string()))
    else {
        return Plan::bare(StatusCode::NOT_FOUND);
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return Plan::bare(StatusCode::NOT_FOUND);
    };

    let range = match parse_range(asked, size) {
        Range::Whole if cap.is_none() || size <= WHOLE_MAX => None,
        // Too large to answer whole in memory: what an engine gets when it asks for the rest of the file.
        Range::Whole => Some((0, size - 1)),
        Range::Bytes(start, end) => Some((start, end)),
        Range::Unsatisfiable => {
            let mut plan = Plan::bare(StatusCode::RANGE_NOT_SATISFIABLE);
            plan.headers
                .push((header::CONTENT_RANGE, format!("bytes */{size}")));
            plan.headers.push((header::ACCEPT_RANGES, "bytes".into()));
            return plan;
        }
    };
    let mut headers = vec![
        (header::CONTENT_TYPE, mime.to_string()),
        (header::ACCEPT_RANGES, "bytes".into()),
        (header::CACHE_CONTROL, "no-store".into()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
    ];
    let (status, start, length) = match range {
        None => (StatusCode::OK, 0, size),
        Some((start, end)) => {
            let end = cap.map_or(end, |cap| end.min(start + cap - 1));
            headers.push((header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")));
            (StatusCode::PARTIAL_CONTENT, start, end + 1 - start)
        }
    };
    headers.push((header::CONTENT_LENGTH, length.to_string()));
    Plan {
        status,
        headers,
        body: (!head).then_some((file, start, length)),
    }
}

fn read_at(file: &mut File, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut body = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut body)?;
    Ok(body)
}

/// The answer to one request of the scheme. `window` is the label of the webview that asked.
pub fn respond(
    store: &FileStore,
    grants: &StreamGrants,
    window: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if window != "main" {
        return empty(StatusCode::NOT_FOUND);
    }
    let asked = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let plan = plan(
        store,
        grants,
        request.method(),
        request.uri().path(),
        asked,
        Some(MAX_BODY),
    );
    let body = match plan.body {
        Some((mut file, start, length)) => match read_at(&mut file, start, length) {
            Ok(body) => Some(body),
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        },
        None => None,
    };
    let mut builder = Response::builder().status(plan.status);
    for (name, value) in plan.headers {
        // A file cut short since (a transfer going back to its last checkpoint) sends what is there.
        let value = match (&name, &body) {
            (&header::CONTENT_LENGTH, Some(body)) => body.len().to_string(),
            _ => value,
        };
        builder = builder.header(name, value);
    }
    builder.body(body.unwrap_or_default()).unwrap()
}

/// With `GHOSTLY_STREAM_LOG` set to a file, one line per request is added to it: what the engine asked for, and how
/// much went back. The Desktop checks read it to see how each engine reads a file.
fn trace_line(method: &str, range: Option<&str>, status: u16, sent: Option<&str>, body: u64) {
    use std::io::Write;
    let Some(path) = std::env::var_os("GHOSTLY_STREAM_LOG") else {
        return;
    };
    let line = format!(
        "[ghostly-file] {method} range={} -> {status} content-range={} body={body}\n",
        range.unwrap_or("-").replace(' ', ""),
        sent.unwrap_or("-").replace(' ', "_"),
    );
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn trace(request: &Request<Vec<u8>>, response: &Response<Vec<u8>>) {
    fn text(value: Option<&header::HeaderValue>) -> Option<&str> {
        value.and_then(|v| v.to_str().ok())
    }
    trace_line(
        request.method().as_str(),
        text(request.headers().get(header::RANGE)),
        response.status().as_u16(),
        text(response.headers().get(header::CONTENT_RANGE)),
        response.body().len() as u64,
    );
}

/// The same files over plain HTTP on 127.0.0.1, for Linux: WebKitGTK's player takes media only from `http(s)` and
/// `blob:` URLs, so it refuses a custom scheme's (a `FormatError` before it even starts). The server takes the same
/// tokens (unguessable, and only the Ghostly window is given them: this is what stands in for the scheme's window
/// check here), answers only a `Host` of exactly `127.0.0.1:<port>` (no other name can be pointed at it), and streams a
/// range from the file to the socket, so nothing is held whole in memory. One thread per connection; the engine opens
/// a new one for each seek.
pub mod loopback {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::Duration;

    /// Starts listening on a free port of 127.0.0.1 and serves until the app ends.
    pub fn start(store: FileStore, grants: StreamGrants) -> Result<u16, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        std::thread::Builder::new()
            .name("ghostly-file".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let (store, grants) = (store.clone(), grants.clone());
                    let _ = std::thread::Builder::new()
                        .name("ghostly-file-conn".into())
                        .spawn(move || {
                            let _ = serve(stream, &store, &grants, port);
                        });
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(port)
    }

    /// A request's method, target and headers (names in lower case).
    type Head = (String, String, Vec<(String, String)>);

    /// The request line and headers, at most 16 KiB of them.
    fn read_head(stream: &TcpStream) -> std::io::Result<Option<Head>> {
        let mut reader = BufReader::new(stream.take(16 * 1024));
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let mut parts = line.split_whitespace();
        let (Some(method), Some(target), Some(_version)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Ok(None);
        };
        let (method, target) = (method.to_string(), target.to_string());
        let mut headers = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                return Ok(None);
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
            }
        }
        Ok(Some((method, target, headers)))
    }

    fn serve(
        mut stream: TcpStream,
        store: &FileStore,
        grants: &StreamGrants,
        port: u16,
    ) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        stream.set_write_timeout(Some(Duration::from_secs(60)))?;
        let Some((method, target, headers)) = read_head(&stream)? else {
            return Ok(());
        };
        let header_of = |name: &str| {
            headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        };
        let method = Method::from_bytes(method.as_bytes()).unwrap_or(Method::POST);
        let host = format!("127.0.0.1:{port}");
        let plan = if header_of("host") != Some(host.as_str()) {
            Plan::bare(StatusCode::NOT_FOUND)
        } else {
            plan(store, grants, &method, &target, header_of("range"), None)
        };

        let mut head = format!(
            "HTTP/1.1 {} {}\r\n",
            plan.status.as_u16(),
            plan.status.canonical_reason().unwrap_or("")
        );
        let mut length = 0;
        for (name, value) in &plan.headers {
            head.push_str(&format!("{}: {value}\r\n", name.as_str()));
        }
        if !plan
            .headers
            .iter()
            .any(|(name, _)| name == header::CONTENT_LENGTH)
        {
            head.push_str("content-length: 0\r\n");
        }
        head.push_str("connection: close\r\n\r\n");
        stream.write_all(head.as_bytes())?;
        let mut sent = 0;
        if let Some((mut file, start, len)) = plan.body {
            length = len;
            file.seek(SeekFrom::Start(start))?;
            // Written until the engine has what it wants: it closes the connection when it seeks elsewhere.
            let mut piece = vec![0u8; 256 * 1024];
            let mut file = file.take(length);
            loop {
                let read = file.read(&mut piece)?;
                if read == 0 || stream.write_all(&piece[..read]).is_err() {
                    break;
                }
                sent += read as u64;
            }
        }
        let _ = stream.flush();
        let content_range = plan
            .headers
            .iter()
            .find(|(name, _)| name == header::CONTENT_RANGE)
            .map(|(_, value)| value.as_str());
        trace_line(
            method.as_str(),
            header_of("range"),
            plan.status.as_u16(),
            content_range,
            sent.min(length),
        );
        Ok(())
    }
}

/// Where a token is served: the scheme (`http://ghostly-file.localhost` on Windows, where WebView2 takes no custom
/// scheme), or the loopback server on Linux.
#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
fn stream_url(token: &str, loopback: Option<u16>) -> String {
    #[cfg(target_os = "linux")]
    if let Some(port) = loopback {
        return format!("http://127.0.0.1:{port}/{token}");
    }
    #[cfg(windows)]
    return format!("http://{SCHEME}.localhost/{token}");
    #[cfg(not(windows))]
    format!("{SCHEME}://localhost/{token}")
}

#[derive(serde::Serialize)]
pub struct StreamOpened {
    pub url: String,
    pub token: String,
}

/// A URL to play a stored file from, and the token that closes it.
#[tauri::command]
pub fn file_bytes_stream_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
    mime: String,
) -> Result<StreamOpened, String> {
    use tauri::Manager;
    let store = app
        .try_state::<FileStore>()
        .ok_or("File storage unavailable")?;
    let grants = app
        .try_state::<StreamGrants>()
        .ok_or("File storage unavailable")?;
    let token = grants.open(&store, &space, &id, &mime)?;
    #[cfg(target_os = "linux")]
    let port = Some(grants.loopback_port(&store)?);
    #[cfg(not(target_os = "linux"))]
    let port = None;
    Ok(StreamOpened {
        url: stream_url(&token, port),
        token,
    })
}

/// The file stops being served under this token.
#[tauri::command]
pub fn file_bytes_stream_close<R: tauri::Runtime>(app: tauri::AppHandle<R>, token: String) {
    use tauri::Manager;
    if let Some(grants) = app.try_state::<StreamGrants>() {
        grants.close(&token);
    }
}

#[cfg(test)]
mod tests {
    // covers: files.video.stream
    use super::*;
    use std::path::PathBuf;

    fn store() -> (FileStore, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ghostly-stream-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        (FileStore::new(dir.clone()), dir)
    }

    fn bytes(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn get(path: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().uri(format!("ghostly-file://localhost{path}"));
        if let Some(range) = range {
            builder = builder.header(header::RANGE, range);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn header_of(response: &Response<Vec<u8>>, name: header::HeaderName) -> Option<&str> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    #[test]
    fn ranges_are_read_like_a_web_server_reads_them() {
        assert_eq!(parse_range(None, 100), Range::Whole);
        assert_eq!(parse_range(Some("items=0-1"), 100), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-1"), 100), Range::Bytes(0, 1));
        assert_eq!(parse_range(Some("bytes=0-"), 100), Range::Bytes(0, 99));
        assert_eq!(
            parse_range(Some("bytes=10-5000"), 100),
            Range::Bytes(10, 99)
        );
        assert_eq!(parse_range(Some("bytes=-10"), 100), Range::Bytes(90, 99));
        assert_eq!(parse_range(Some("bytes=-500"), 100), Range::Bytes(0, 99));
        assert_eq!(
            parse_range(Some("bytes=5-9, 20-30"), 100),
            Range::Bytes(5, 9)
        );
        assert_eq!(
            parse_range(Some(" bytes=99-99 "), 100),
            Range::Bytes(99, 99)
        );
        for bad in [
            "bytes=100-",
            "bytes=100-200",
            "bytes=9-5",
            "bytes=-0",
            "bytes=-",
            "bytes=a-b",
            "bytes=5",
            "bytes=+5-9",
            "bytes=0-1x",
        ] {
            assert_eq!(parse_range(Some(bad), 100), Range::Unsatisfiable, "{bad}");
        }
        assert_eq!(parse_range(Some("bytes=0-"), 0), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-5"), 0), Range::Unsatisfiable);
    }

    #[test]
    fn a_range_comes_back_as_206_with_its_bytes_and_its_place_in_the_file() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        let data = bytes(10 * 1024 * 1024);
        files.append("p", "chat-in-1", 0, &data).unwrap();
        let token = grants.open(&files, "p", "chat-in-1", "video/mp4").unwrap();

        let first = respond(
            &files,
            &grants,
            "main",
            &get(&format!("/{token}"), Some("bytes=0-1")),
        );
        assert_eq!(first.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(first.body(), &data[0..2]);
        assert_eq!(
            header_of(&first, header::CONTENT_RANGE),
            Some("bytes 0-1/10485760")
        );
        assert_eq!(header_of(&first, header::CONTENT_LENGTH), Some("2"));
        assert_eq!(header_of(&first, header::ACCEPT_RANGES), Some("bytes"));
        assert_eq!(header_of(&first, header::CONTENT_TYPE), Some("video/mp4"));
        assert_eq!(
            header_of(&first, header::X_CONTENT_TYPE_OPTIONS),
            Some("nosniff")
        );

        let middle = respond(
            &files,
            &grants,
            "main",
            &get(&format!("/{token}"), Some("bytes=5000000-5000099")),
        );
        assert_eq!(middle.body(), &data[5_000_000..5_000_100]);

        // An open range is answered a piece at a time.
        let rest = respond(
            &files,
            &grants,
            "main",
            &get(&format!("/{token}"), Some("bytes=1000-")),
        );
        assert_eq!(rest.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(rest.body().len() as u64, MAX_BODY);
        assert_eq!(rest.body()[..], data[1000..1000 + MAX_BODY as usize]);
        assert_eq!(
            header_of(&rest, header::CONTENT_RANGE).map(str::to_string),
            Some(format!("bytes 1000-{}/10485760", 1000 + MAX_BODY - 1))
        );
        let tail = respond(
            &files,
            &grants,
            "main",
            &get(&format!("/{token}"), Some("bytes=-100")),
        );
        assert_eq!(tail.body(), &data[data.len() - 100..]);

        // No range: a small file whole, with its length.
        let whole = respond(&files, &grants, "main", &get(&format!("/{token}"), None));
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body().len(), data.len());
        assert_eq!(header_of(&whole, header::CONTENT_LENGTH), Some("10485760"));

        // HEAD: the headers, no body.
        let mut head = get(&format!("/{token}"), Some("bytes=0-99"));
        *head.method_mut() = Method::HEAD;
        let head = respond(&files, &grants, "main", &head);
        assert_eq!(head.status(), StatusCode::PARTIAL_CONTENT);
        assert!(head.body().is_empty());
        assert_eq!(header_of(&head, header::CONTENT_LENGTH), Some("100"));
        fs_cleanup(dir);
    }

    #[test]
    fn a_large_file_asked_for_whole_comes_back_as_its_first_piece() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        let step = bytes(1024 * 1024);
        for index in 0..(WHOLE_MAX / step.len() as u64 + 1) {
            files
                .append("p", "big", index * step.len() as u64, &step)
                .unwrap();
        }
        let size = files.size("p", "big").unwrap().unwrap();
        let token = grants.open(&files, "p", "big", "video/webm").unwrap();
        let answer = respond(&files, &grants, "main", &get(&format!("/{token}"), None));
        assert_eq!(answer.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(answer.body().len() as u64, MAX_BODY);
        assert_eq!(
            header_of(&answer, header::CONTENT_RANGE).map(str::to_string),
            Some(format!("bytes 0-{}/{size}", MAX_BODY - 1))
        );
        fs_cleanup(dir);
    }

    #[test]
    fn a_range_outside_the_file_is_416_with_the_file_size() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        files.append("p", "f", 0, &bytes(1000)).unwrap();
        let token = grants.open(&files, "p", "f", "audio/webm").unwrap();
        for range in ["bytes=1000-", "bytes=2000-3000", "bytes=50-10", "bytes=x-"] {
            let answer = respond(
                &files,
                &grants,
                "main",
                &get(&format!("/{token}"), Some(range)),
            );
            assert_eq!(
                answer.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{range}"
            );
            assert_eq!(
                header_of(&answer, header::CONTENT_RANGE),
                Some("bytes */1000")
            );
            assert!(answer.body().is_empty());
        }
        fs_cleanup(dir);
    }

    #[test]
    fn an_unknown_or_closed_token_is_404() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        files.append("p", "f", 0, &bytes(10)).unwrap();
        let unknown = URL_SAFE_NO_PAD.encode([7u8; 32]);
        assert_eq!(
            respond(&files, &grants, "main", &get(&format!("/{unknown}"), None)).status(),
            StatusCode::NOT_FOUND
        );
        let token = grants.open(&files, "p", "f", "video/mp4").unwrap();
        assert_eq!(
            respond(&files, &grants, "main", &get(&format!("/{token}"), None)).status(),
            StatusCode::OK
        );
        grants.close(&token);
        assert_eq!(
            respond(&files, &grants, "main", &get(&format!("/{token}"), None)).status(),
            StatusCode::NOT_FOUND
        );
        // A file removed since: gone too.
        let token = grants.open(&files, "p", "f", "video/mp4").unwrap();
        files.remove("p", "f").unwrap();
        assert_eq!(
            respond(&files, &grants, "main", &get(&format!("/{token}"), None)).status(),
            StatusCode::NOT_FOUND
        );
        // No token for a file that is not there.
        assert!(grants.open(&files, "p", "missing", "video/mp4").is_err());
        fs_cleanup(dir);
    }

    #[test]
    fn paths_ids_and_other_windows_get_nothing() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        files.append("p", "f", 0, b"secret").unwrap();
        std::fs::write(dir.join("outside"), b"outside").unwrap();
        let token = grants.open(&files, "p", "f", "video/mp4").unwrap();
        // Ids and spaces that name a path are refused before any token.
        for (space, id) in [
            ("p", "../outside"),
            ("..", "outside"),
            ("p", "a/b"),
            ("p", ""),
            ("p/..", "f"),
        ] {
            assert!(
                grants.open(&files, space, id, "video/mp4").is_err(),
                "{space} {id}"
            );
        }
        for path in [
            "/",
            "",
            "/p/f",
            "/../outside",
            "/..%2Foutside",
            "/%2e%2e/outside",
            "/f",
            &format!("/{token}/"),
            &format!("/{token}/../f"),
            &format!("/p/{token}"),
            &format!("/{token}x"),
        ] {
            let uri = format!("ghostly-file://localhost{path}");
            let Ok(request) = Request::builder().uri(uri.as_str()).body(Vec::new()) else {
                continue;
            };
            assert_eq!(
                respond(&files, &grants, "main", &request).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        // A contact's app in a window of its own, with a real token: nothing.
        assert_eq!(
            respond(&files, &grants, "svc-1", &get(&format!("/{token}"), None)).status(),
            StatusCode::NOT_FOUND
        );
        let mut post = get(&format!("/{token}"), None);
        *post.method_mut() = Method::POST;
        assert_eq!(
            respond(&files, &grants, "main", &post).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        fs_cleanup(dir);
    }

    #[test]
    fn tokens_are_new_each_time_typed_by_what_plays_and_limited_in_number() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        files.append("p", "f", 0, b"x").unwrap();
        files.append("q", "f", 0, b"x").unwrap();
        let first = grants.open(&files, "p", "f", "video/mp4").unwrap();
        let second = grants.open(&files, "p", "f", "video/mp4").unwrap();
        assert_ne!(first, second);
        assert_eq!(first.len(), 43);
        let html = grants.open(&files, "p", "f", "text/html").unwrap();
        let answer = respond(&files, &grants, "main", &get(&format!("/{html}"), None));
        assert_eq!(
            header_of(&answer, header::CONTENT_TYPE),
            Some("application/octet-stream")
        );
        let typed = grants
            .open(&files, "p", "f", "Video/MP4; codecs=avc1")
            .unwrap();
        let answer = respond(&files, &grants, "main", &get(&format!("/{typed}"), None));
        assert_eq!(header_of(&answer, header::CONTENT_TYPE), Some("video/mp4"));

        let other = grants.open(&files, "q", "f", "video/mp4").unwrap();
        grants.close_space("p");
        assert_eq!(
            respond(&files, &grants, "main", &get(&format!("/{first}"), None)).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(&files, &grants, "main", &get(&format!("/{other}"), None)).status(),
            StatusCode::OK
        );

        let tokens: Vec<String> = (0..MAX_GRANTS + 1)
            .map(|_| grants.open(&files, "p", "f", "video/mp4").unwrap())
            .collect();
        assert_eq!(
            respond(
                &files,
                &grants,
                "main",
                &get(&format!("/{}", tokens[0]), None)
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(
                &files,
                &grants,
                "main",
                &get(&format!("/{}", tokens[MAX_GRANTS]), None)
            )
            .status(),
            StatusCode::OK
        );
        fs_cleanup(dir);
    }

    /// One request to the loopback server, and its whole answer: status line, headers (lower case), body.
    fn over_http(port: u16, head: &str) -> (String, Vec<(String, String)>, Vec<u8>) {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(head.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let text = String::from_utf8(raw[..split].to_vec()).unwrap();
        let mut lines = text.split("\r\n");
        let status = lines.next().unwrap().to_string();
        let headers = lines
            .filter_map(|line| line.split_once(": "))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.to_string()))
            .collect();
        (status, headers, raw[split + 4..].to_vec())
    }

    fn named<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn over_loopback_http_a_range_streams_to_its_end_and_a_plain_get_gets_the_whole_file() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        let data = bytes(20 * 1024 * 1024 + 7);
        for (index, piece) in data.chunks(1024 * 1024).enumerate() {
            files
                .append("p", "big", (index * 1024 * 1024) as u64, piece)
                .unwrap();
        }
        let token = grants.open(&files, "p", "big", "video/mp4").unwrap();
        let port = grants.loopback_port(&files).unwrap();
        assert_eq!(grants.loopback_port(&files).unwrap(), port, "one server");
        let host = format!("Host: 127.0.0.1:{port}");

        // What WebKitGTK sends first: no range. The whole file, streamed.
        let (status, headers, body) =
            over_http(port, &format!("GET /{token} HTTP/1.1\r\n{host}\r\n\r\n"));
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(body, data);
        assert_eq!(
            named(&headers, "content-length"),
            Some(data.len().to_string().as_str())
        );
        assert_eq!(named(&headers, "accept-ranges"), Some("bytes"));
        assert_eq!(named(&headers, "content-type"), Some("video/mp4"));
        assert_eq!(named(&headers, "connection"), Some("close"));

        // Then from where it seeks, to the end: past the scheme's 4 MiB, since nothing is held in memory here.
        let from = 5 * 1024 * 1024 + 3;
        let (status, headers, body) = over_http(
            port,
            &format!("GET /{token} HTTP/1.1\r\n{host}\r\nRange: bytes={from}-\r\n\r\n"),
        );
        assert_eq!(status, "HTTP/1.1 206 Partial Content");
        assert_eq!(body[..], data[from..]);
        assert_eq!(
            named(&headers, "content-range").map(str::to_string),
            Some(format!("bytes {from}-{}/{}", data.len() - 1, data.len()))
        );
        let (status, headers, body) = over_http(
            port,
            &format!("GET /{token} HTTP/1.1\r\n{host}\r\nrange: bytes=-4\r\n\r\n"),
        );
        assert_eq!(status, "HTTP/1.1 206 Partial Content");
        assert_eq!(body[..], data[data.len() - 4..]);
        assert_eq!(named(&headers, "content-length"), Some("4"));
        let (status, headers, body) = over_http(
            port,
            &format!(
                "GET /{token} HTTP/1.1\r\n{host}\r\nRange: bytes={}-\r\n\r\n",
                data.len()
            ),
        );
        assert_eq!(status, "HTTP/1.1 416 Range Not Satisfiable");
        assert_eq!(
            named(&headers, "content-range").map(str::to_string),
            Some(format!("bytes */{}", data.len()))
        );
        assert!(body.is_empty());
        let (status, _, body) =
            over_http(port, &format!("HEAD /{token} HTTP/1.1\r\n{host}\r\n\r\n"));
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(body.is_empty());
        fs_cleanup(dir);
    }

    #[test]
    fn over_loopback_http_only_a_token_and_the_exact_host_get_anything() {
        let (files, dir) = store();
        let grants = StreamGrants::default();
        files.append("p", "f", 0, b"secret").unwrap();
        std::fs::write(dir.join("outside"), b"outside").unwrap();
        let token = grants.open(&files, "p", "f", "video/mp4").unwrap();
        let port = grants.loopback_port(&files).unwrap();
        let host = format!("Host: 127.0.0.1:{port}");
        let ok = over_http(port, &format!("GET /{token} HTTP/1.1\r\n{host}\r\n\r\n"));
        assert_eq!(
            (ok.0.as_str(), ok.2.as_slice()),
            ("HTTP/1.1 200 OK", &b"secret"[..])
        );
        for target in [
            "/",
            "/p/f",
            "/../outside",
            "/%2e%2e/outside",
            "/f",
            &format!("/{token}/"),
            &format!("/{token}?x"),
            &format!("/p/{token}"),
        ] {
            let (status, _, body) =
                over_http(port, &format!("GET {target} HTTP/1.1\r\n{host}\r\n\r\n"));
            assert_eq!(status, "HTTP/1.1 404 Not Found", "{target}");
            assert!(body.is_empty(), "{target}");
        }
        // A name pointed at 127.0.0.1 (DNS rebinding), another spelling of it, or none: nothing.
        for host in [
            "Host: evil.example:{port}".replace("{port}", &port.to_string()),
            format!("Host: localhost:{port}"),
            "Host: 127.0.0.1".to_string(),
            String::new(),
        ] {
            let (status, _, body) =
                over_http(port, &format!("GET /{token} HTTP/1.1\r\n{host}\r\n\r\n"));
            assert_eq!(status, "HTTP/1.1 404 Not Found", "{host}");
            assert!(body.is_empty());
        }
        let (status, _, _) = over_http(port, &format!("POST /{token} HTTP/1.1\r\n{host}\r\n\r\n"));
        assert_eq!(status, "HTTP/1.1 405 Method Not Allowed");
        // Not HTTP at all: the connection just ends.
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        std::io::Write::write_all(&mut stream, b"\r\n\r\n").unwrap();
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).unwrap();
        assert!(rest.is_empty());
        grants.close(&token);
        let (status, _, _) = over_http(port, &format!("GET /{token} HTTP/1.1\r\n{host}\r\n\r\n"));
        assert_eq!(status, "HTTP/1.1 404 Not Found");
        fs_cleanup(dir);
    }

    #[test]
    fn the_url_is_the_platform_s_own() {
        let url = stream_url("tok", Some(4321));
        #[cfg(target_os = "linux")]
        assert_eq!(url, "http://127.0.0.1:4321/tok");
        #[cfg(windows)]
        assert_eq!(url, "http://ghostly-file.localhost/tok");
        #[cfg(target_os = "macos")]
        assert_eq!(url, "ghostly-file://localhost/tok");
    }

    fn fs_cleanup(dir: PathBuf) {
        std::fs::remove_dir_all(dir).ok();
    }
}
