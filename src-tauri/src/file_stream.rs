//! A stored file played in place (`<video>`, `<audio>`) without the page holding it: the `ghostly-file` scheme
//! serves a file of the store (`file_store.rs`) in ranges, the way a web server serves a video.
//!
//! The page asks for a file with `file_bytes_stream_open` and gets a token: 32 random bytes, new each time, known
//! only to this run of the app. The URL is `ghostly-file://localhost/<token>` (`http://ghostly-file.localhost/<token>`
//! on Windows). The token stands for one file of one profile's folder, checked when it was given; nothing in a URL is
//! ever read as a path, and there is nothing to list. Only the Ghostly window is answered: a window showing a
//! contact's app (`viewer.rs`) reaches the scheme too, and gets 404 whatever it asks.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

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

#[derive(Default)]
pub struct StreamGrants {
    grants: Mutex<HashMap<String, Grant>>,
    next: Mutex<u64>,
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
        let serial = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
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
    let not_found = || empty(StatusCode::NOT_FOUND);
    if window != "main" {
        return not_found();
    }
    let head = request.method() == Method::HEAD;
    if !head && request.method() != Method::GET {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    // The path is one token and nothing else: `/<token>`.
    let Some(token) = request.uri().path().strip_prefix('/') else {
        return not_found();
    };
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return not_found();
    }
    let Some((space, id, mime)) = grants.lookup(token) else {
        return not_found();
    };
    let Ok(path) = store.path_of(&space, &id) else {
        return not_found();
    };
    let Ok(mut file) = File::open(path) else {
        return not_found();
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return not_found();
    };

    let asked = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let range = match parse_range(asked, size) {
        Range::Whole if size <= WHOLE_MAX => None,
        // Too large to answer whole: what an engine gets when it asks for the rest of the file.
        Range::Whole => Some((0, size - 1)),
        Range::Bytes(start, end) => Some((start, end)),
        Range::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Vec::new())
                .unwrap();
        }
    };

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    let (builder, start, length) = match range {
        None => (builder.status(StatusCode::OK), 0, size),
        Some((start, end)) => {
            let end = end.min(start + MAX_BODY - 1);
            (
                builder
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")),
                start,
                end + 1 - start,
            )
        }
    };
    let body = if head {
        Vec::new()
    } else {
        match read_at(&mut file, start, length) {
            Ok(body) => body,
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        }
    };
    // A file cut short since (a transfer going back to its last checkpoint) sends what is there.
    let length = if head { length } else { body.len() as u64 };
    builder
        .header(header::CONTENT_LENGTH, length)
        .body(body)
        .unwrap()
}

/// A token to play a stored file through the scheme.
#[tauri::command]
pub fn file_bytes_stream_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
    mime: String,
) -> Result<String, String> {
    use tauri::Manager;
    let store = app
        .try_state::<FileStore>()
        .ok_or("File storage unavailable")?;
    let grants = app
        .try_state::<StreamGrants>()
        .ok_or("File storage unavailable")?;
    grants.open(&store, &space, &id, &mime)
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

    fn fs_cleanup(dir: PathBuf) {
        std::fs::remove_dir_all(dir).ok();
    }
}
