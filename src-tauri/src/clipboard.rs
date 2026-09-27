use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::Manager;

/// The most text one paste hands to the page. Invites, links, invoices and signature blocks fit
/// many times over; anything longer is refused, and the page asks for Cmd/Ctrl+V instead.
pub const MAX_CLIPBOARD_BYTES: usize = 64 * 1024;

/// Where the text comes from: the system clipboard in the app, a stand-in in tests, so no test
/// ever reads the clipboard of the machine running it.
#[derive(Clone)]
pub struct ClipboardSource(Arc<dyn Fn() -> Result<String, String> + Send + Sync>);

impl ClipboardSource {
    #[cfg_attr(feature = "e2e-driver", allow(dead_code))]
    pub fn system() -> Self {
        Self(Arc::new(|| match arboard::Clipboard::new() {
            Ok(mut clipboard) => match clipboard.get_text() {
                Ok(text) => Ok(text),
                // Nothing, or no text (an image, a file): the page says the clipboard is empty.
                Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
                Err(e) => Err(e.to_string()),
            },
            Err(e) => Err(e.to_string()),
        }))
    }

    #[cfg(any(test, feature = "e2e-driver"))]
    pub fn fixed(read: impl Fn() -> Result<String, String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(read))
    }
}

/// The clipboard's text, for the paste button someone just clicked in the Ghostly window.
///
/// WKWebView answers `navigator.clipboard.readText()` with a "Paste" callout that has to be
/// clicked a second time; reading here takes one click. Only text, at most
/// [`MAX_CLIPBOARD_BYTES`], and only for the main window: a `ghostly-svc://` window shows a
/// contact's code, and the capabilities, `only_main` and this check each keep it out. Only the UI
/// calls it, from a click (`src/lib/clipboard.ts` checks the page's user activation first); the
/// engine never reads the clipboard.
#[tauri::command]
pub async fn read_clipboard_text<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Not allowed from this window".into());
    }
    let source = window
        .try_state::<ClipboardSource>()
        .ok_or("Clipboard unavailable")?
        .inner()
        .clone();
    // X11 may wait on the clipboard's owner: off the main thread, so the window never freezes.
    let text = tauri::async_runtime::spawn_blocking(move || (source.0)())
        .await
        .map_err(|e| e.to_string())??;
    bounded(text)
}

fn bounded(text: String) -> Result<String, String> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err("The clipboard holds too much text".into());
    }
    Ok(text)
}

/// A paste made ready for the page: the files it may read, or a picture's PNG.
enum Ready {
    Files(Vec<(PathBuf, String, u64)>),
    Png(Vec<u8>),
    Nothing,
}

/// What a paste of files can bring: files copied in a file manager (their paths), or a picture.
pub enum Pasted {
    Files(Vec<PathBuf>),
    Image {
        width: usize,
        height: usize,
        rgba: Vec<u8>,
    },
    Nothing,
}

/// Where pasted files come from: the system clipboard in the app, a stand-in in tests (as
/// [`ClipboardSource`]), so `cargo test` never reads the clipboard of the machine running it.
#[derive(Clone)]
pub struct PasteSource(Arc<dyn Fn() -> Result<Pasted, String> + Send + Sync>);

impl PasteSource {
    #[cfg_attr(feature = "e2e-driver", allow(dead_code))]
    pub fn system() -> Self {
        Self(Arc::new(|| {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            // Files first: a file manager puts their icon beside them, which is not what was copied.
            if let Ok(files) = clipboard.get().file_list() {
                if !files.is_empty() {
                    return Ok(Pasted::Files(files));
                }
            }
            match clipboard.get_image() {
                Ok(image) => Ok(Pasted::Image {
                    width: image.width,
                    height: image.height,
                    rgba: image.bytes.into_owned(),
                }),
                Err(arboard::Error::ContentNotAvailable) => Ok(Pasted::Nothing),
                Err(e) => Err(e.to_string()),
            }
        }))
    }

    #[cfg(any(test, feature = "e2e-driver"))]
    pub fn fixed(read: impl Fn() -> Result<Pasted, String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(read))
    }
}

/// The most files one paste brings.
pub const MAX_PASTED_FILES: usize = 32;
/// The largest picture a paste turns into a PNG (100 megapixels, a 400 MB bitmap).
pub const MAX_PASTED_PIXELS: usize = 100_000_000;
/// The most bytes one read hands the page.
const MAX_READ: u64 = 16 * 1024 * 1024;
/// What the shelf keeps: the latest pastes, a bounded amount of picture bytes.
const SHELF_ITEMS: usize = 64;
const SHELF_BYTES: usize = 256 * 1024 * 1024;

enum Held {
    Bytes(Arc<Vec<u8>>),
    Path(PathBuf),
}

/// What recent pastes brought, by token: the page reads them from here and nowhere else, so
/// it can read exactly the files someone copied and the picture a paste made, never a path of
/// its choosing. Kept in memory, the latest [`SHELF_ITEMS`] only.
#[derive(Default)]
pub struct PasteShelf(Mutex<ShelfInner>);

#[derive(Default)]
struct ShelfInner {
    next: u64,
    held: VecDeque<(String, Held)>,
}

impl PasteShelf {
    fn put(&self, held: Held) -> String {
        let mut shelf = self.0.lock().unwrap();
        shelf.next += 1;
        let token = format!("paste-{}", shelf.next);
        shelf.held.push_back((token.clone(), held));
        let bytes = |held: &VecDeque<(String, Held)>| {
            held.iter()
                .map(|(_, h)| match h {
                    Held::Bytes(b) => b.len(),
                    Held::Path(_) => 0,
                })
                .sum::<usize>()
        };
        while shelf.held.len() > SHELF_ITEMS
            || (shelf.held.len() > 1 && bytes(&shelf.held) > SHELF_BYTES)
        {
            shelf.held.pop_front();
        }
        token
    }

    fn get(&self, token: &str) -> Option<Held> {
        let shelf = self.0.lock().unwrap();
        shelf
            .held
            .iter()
            .find(|(t, _)| t == token)
            .map(|(_, h)| match h {
                Held::Bytes(b) => Held::Bytes(b.clone()),
                Held::Path(p) => Held::Path(p.clone()),
            })
    }
}

/// One thing a paste brought, for the page's sheet. `name` is None for a picture (the page
/// names it after the moment it was pasted).
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct PastedItem {
    pub token: String,
    pub name: Option<String>,
    pub size: u64,
    pub mime: Option<String>,
}

/// A bitmap as a PNG: what a picture pasted from the clipboard is sent as.
pub fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width.saturating_mul(height) > MAX_PASTED_PIXELS {
        return Err("That picture is too large to paste".into());
    }
    if rgba.len() != width * height * 4 {
        return Err("The clipboard's picture is damaged".into());
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

/// The files of a paste the page may read: regular files only (a copied folder is not sent),
/// each once, at most [`MAX_PASTED_FILES`], with their names and sizes.
pub fn pasted_files(paths: Vec<PathBuf>) -> Vec<(PathBuf, String, u64)> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| path.is_absolute() && seen.insert(path.clone()))
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            let name = path.file_name()?.to_str()?.to_string();
            meta.is_file().then_some((path, name, meta.len()))
        })
        .take(MAX_PASTED_FILES)
        .collect()
}

/// Files copied as text, one `file://` URI a line (as some Linux desktops hand them over when
/// asked for text): their paths, or None when the text is anything else.
pub fn paths_from_uri_list(text: &str) -> Option<Vec<PathBuf>> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return None;
    }
    lines
        .into_iter()
        .map(|line| {
            url::Url::parse(line)
                .ok()
                .filter(|u| u.scheme() == "file")?
                .to_file_path()
                .ok()
        })
        .collect()
}

/// What a paste brought that the page could not see itself: files copied in a file manager,
/// or a picture (made a PNG here). Called only from a paste in the composer that carried
/// neither files nor text (WebKit on macOS hands the page both itself), from the main window.
/// The bytes stay here; the page reads them with [`read_pasted_bytes`].
#[tauri::command]
pub async fn read_clipboard_files<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<Vec<PastedItem>, String> {
    if window.label() != "main" {
        return Err("Not allowed from this window".into());
    }
    let source = window
        .try_state::<PasteSource>()
        .ok_or("Clipboard unavailable")?
        .inner()
        .clone();
    let text = window
        .try_state::<ClipboardSource>()
        .map(|s| s.inner().clone());
    let pasted = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let pasted = match (source.0)()? {
            // Nothing else: a file list some desktops only give as text.
            Pasted::Nothing => match text.map(|t| (t.0)()) {
                Some(Ok(text)) => paths_from_uri_list(&text).map_or(Pasted::Nothing, Pasted::Files),
                _ => Pasted::Nothing,
            },
            other => other,
        };
        Ok(match pasted {
            Pasted::Files(paths) => Ready::Files(pasted_files(paths)),
            Pasted::Image {
                width,
                height,
                rgba,
            } => Ready::Png(encode_png(width, height, &rgba)?),
            Pasted::Nothing => Ready::Nothing,
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let shelf = window
        .try_state::<PasteShelf>()
        .ok_or("Clipboard unavailable")?;
    Ok(match pasted {
        Ready::Nothing => Vec::new(),
        Ready::Png(png) => {
            let size = png.len() as u64;
            vec![PastedItem {
                token: shelf.put(Held::Bytes(Arc::new(png))),
                name: None,
                size,
                mime: Some("image/png".into()),
            }]
        }
        Ready::Files(files) => files
            .into_iter()
            .map(|(path, name, size)| PastedItem {
                token: shelf.put(Held::Path(path)),
                name: Some(name),
                size,
                mime: None,
            })
            .collect(),
    })
}

/// A step of what a paste brought ([`read_clipboard_files`]), as raw bytes: at most 16 MiB
/// from `offset`, fewer at the end.
#[tauri::command]
pub async fn read_pasted_bytes<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    token: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    if window.label() != "main" {
        return Err("Not allowed from this window".into());
    }
    let held = window
        .try_state::<PasteShelf>()
        .and_then(|shelf| shelf.get(&token))
        .ok_or("That paste is gone. Paste it again.")?;
    let length = length.min(MAX_READ);
    let bytes = tauri::async_runtime::spawn_blocking(move || read_held(held, offset, length))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

fn read_held(held: Held, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    match held {
        Held::Bytes(bytes) => {
            let start = (offset as usize).min(bytes.len());
            let end = start.saturating_add(length as usize).min(bytes.len());
            Ok(bytes[start..end].to_vec())
        }
        Held::Path(path) => {
            let mut file =
                File::open(&path).map_err(|e| format!("Could not read the file: {e}"))?;
            file.seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            file.take(length)
                .read_to_end(&mut out)
                .map_err(|e| format!("Could not read the file: {e}"))?;
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    // covers: invite.clipboard, app.composer.paste-files
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    fn app(source: ClipboardSource) -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(source)
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn read(window: tauri::WebviewWindow<MockRuntime>) -> Result<String, String> {
        tauri::async_runtime::block_on(read_clipboard_text(window))
    }

    #[test]
    fn the_ghostly_window_gets_the_text() {
        let app = app(ClipboardSource::fixed(|| Ok("ghostly://join#abc\n".into())));
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert_eq!(read(main), Ok("ghostly://join#abc\n".into()));
    }

    #[test]
    fn any_other_window_is_refused_before_the_clipboard_is_read() {
        let reads = Arc::new(AtomicUsize::new(0));
        let counted = reads.clone();
        let app = app(ClipboardSource::fixed(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok("secret".into())
        }));
        for label in ["svc-1", "main-2", "Main"] {
            let url = "ghostly-svc://atlas.peer/".parse().unwrap();
            let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::CustomProtocol(url))
                .build()
                .unwrap();
            assert_eq!(read(window), Err("Not allowed from this window".into()));
        }
        assert_eq!(reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn text_is_bounded() {
        let longest = "a".repeat(MAX_CLIPBOARD_BYTES);
        assert_eq!(bounded(longest.clone()), Ok(longest));
        // Bytes, not characters: 3-byte characters reach the bound sooner.
        let wide = "€".repeat(MAX_CLIPBOARD_BYTES / 3 + 1);
        assert!(bounded(wide).is_err());
        let app = app(ClipboardSource::fixed(|| {
            Ok("a".repeat(MAX_CLIPBOARD_BYTES + 1))
        }));
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert_eq!(read(main), Err("The clipboard holds too much text".into()));
    }

    #[test]
    fn a_failed_read_is_an_error_and_no_source_is_unavailable() {
        let app = app(ClipboardSource::fixed(|| Err("no display".into())));
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert_eq!(read(main), Err("no display".into()));
        let bare = mock_builder()
            .build(tauri::generate_context!(test = true))
            .unwrap();
        let main = WebviewWindowBuilder::new(&bare, "main", Default::default())
            .build()
            .unwrap();
        assert_eq!(read(main), Err("Clipboard unavailable".into()));
    }

    fn scratch() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ghostly-paste-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paste_app(source: PasteSource) -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(source)
            .manage(PasteShelf::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn main_window(app: &tauri::App<MockRuntime>) -> tauri::WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, "main", Default::default())
            .build()
            .unwrap()
    }

    fn files(window: &tauri::WebviewWindow<MockRuntime>) -> Result<Vec<PastedItem>, String> {
        tauri::async_runtime::block_on(read_clipboard_files(window.clone()))
    }

    /// Everything a paste brought, read the way the page reads it: `step` bytes at a time.
    fn bytes(
        window: &tauri::WebviewWindow<MockRuntime>,
        token: &str,
        step: u64,
    ) -> Result<Vec<u8>, String> {
        let mut all = Vec::new();
        loop {
            let got = tauri::async_runtime::block_on(read_pasted_bytes(
                window.clone(),
                token.into(),
                all.len() as u64,
                step,
            ))?;
            let got = match tauri::ipc::IpcResponse::body(got).unwrap() {
                tauri::ipc::InvokeResponseBody::Raw(raw) => raw.clone(),
                other => panic!("not raw bytes: {other:?}"),
            };
            if got.is_empty() {
                return Ok(all);
            }
            all.extend(got);
        }
    }

    fn decode(png_bytes: &[u8]) -> (u32, u32, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
            .read_info()
            .unwrap();
        let mut out = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut out).unwrap();
        out.truncate(info.buffer_size());
        (info.width, info.height, out)
    }

    #[test]
    fn a_picture_becomes_a_png_of_the_same_pixels() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 21) as u8).collect();
        let png_bytes = encode_png(3, 2, &rgba).unwrap();
        assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(decode(&png_bytes), (3, 2, rgba));
        assert!(encode_png(0, 2, &[]).is_err());
        assert!(
            encode_png(3, 2, &[0; 5]).is_err(),
            "a bitmap of the wrong length"
        );
        assert_eq!(
            encode_png(MAX_PASTED_PIXELS, 2, &[]),
            Err("That picture is too large to paste".into())
        );
    }

    #[test]
    fn file_uris_are_paths_and_anything_else_is_not() {
        let text = "# copied\r\nfile:///tmp/haunted%20house.pdf\r\nfile:///tmp/notes.txt\n";
        #[cfg(unix)]
        assert_eq!(
            paths_from_uri_list(text),
            Some(vec![
                PathBuf::from("/tmp/haunted house.pdf"),
                PathBuf::from("/tmp/notes.txt")
            ])
        );
        #[cfg(not(unix))]
        let _ = text;
        assert_eq!(
            paths_from_uri_list("file:///tmp/a.txt\nhttps://ghostly.tools/"),
            None
        );
        assert_eq!(paths_from_uri_list("just words"), None);
        assert_eq!(paths_from_uri_list(" \n"), None);
    }

    #[test]
    fn only_regular_files_each_once_and_at_most_a_bounded_number() {
        let dir = scratch();
        std::fs::write(dir.join("a.txt"), b"boo").unwrap();
        std::fs::create_dir(dir.join("folder")).unwrap();
        let picked = pasted_files(vec![
            dir.join("a.txt"),
            dir.join("folder"),
            dir.join("missing.bin"),
            dir.join("a.txt"),
            PathBuf::from("relative.txt"),
        ]);
        assert_eq!(picked, vec![(dir.join("a.txt"), "a.txt".into(), 3)]);
        let many: Vec<PathBuf> = (0..MAX_PASTED_FILES + 5)
            .map(|i| {
                let path = dir.join(format!("{i}.txt"));
                std::fs::write(&path, b"x").unwrap();
                path
            })
            .collect();
        assert_eq!(pasted_files(many).len(), MAX_PASTED_FILES);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_pasted_picture_is_read_back_as_its_png_in_steps() {
        let rgba: Vec<u8> = (0..64 * 48 * 4).map(|i| (i % 251) as u8).collect();
        let bitmap = rgba.clone();
        let app = paste_app(PasteSource::fixed(move || {
            Ok(Pasted::Image {
                width: 64,
                height: 48,
                rgba: bitmap.clone(),
            })
        }));
        let main = main_window(&app);
        let items = files(&main).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            (items[0].name.as_deref(), items[0].mime.as_deref()),
            (None, Some("image/png"))
        );
        let png_bytes = bytes(&main, &items[0].token, 100).unwrap();
        assert_eq!(png_bytes.len() as u64, items[0].size);
        assert_eq!(decode(&png_bytes), (64, 48, rgba));
    }

    #[test]
    fn copied_files_are_named_sized_and_read_from_where_they_are() {
        let dir = scratch();
        let content: Vec<u8> = (0..70_000u32).map(|i| (i % 253) as u8).collect();
        std::fs::write(dir.join("ghost story.pdf"), &content).unwrap();
        std::fs::write(dir.join("notes.txt"), b"attic").unwrap();
        let paths = vec![dir.join("ghost story.pdf"), dir.join("notes.txt")];
        let app = paste_app(PasteSource::fixed(move || Ok(Pasted::Files(paths.clone()))));
        let main = main_window(&app);
        let items = files(&main).unwrap();
        let named: Vec<_> = items
            .iter()
            .map(|i| (i.name.clone().unwrap(), i.size, i.mime.clone()))
            .collect();
        assert_eq!(
            named,
            vec![
                ("ghost story.pdf".into(), 70_000, None),
                ("notes.txt".into(), 5, None)
            ]
        );
        assert_eq!(bytes(&main, &items[0].token, 4096).unwrap(), content);
        assert_eq!(bytes(&main, &items[1].token, 2).unwrap(), b"attic");
        // A token the shelf never gave out reads nothing.
        assert_eq!(
            bytes(&main, "paste-999", 10),
            Err("That paste is gone. Paste it again.".into())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nothing_but_file_uris_as_text_is_files_too() {
        let dir = scratch();
        std::fs::write(dir.join("route.csv"), b"a,b").unwrap();
        let uri = url::Url::from_file_path(dir.join("route.csv"))
            .unwrap()
            .to_string();
        let app = mock_builder()
            .manage(PasteSource::fixed(|| Ok(Pasted::Nothing)))
            .manage(ClipboardSource::fixed(move || Ok(format!("{uri}\n"))))
            .manage(PasteShelf::default())
            .build(tauri::generate_context!(test = true))
            .unwrap();
        let items = files(&main_window(&app)).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i.name.clone().unwrap())
                .collect::<Vec<_>>(),
            vec!["route.csv"]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_paste_is_read_only_by_the_ghostly_window_and_only_when_there_is_a_source() {
        let reads = Arc::new(AtomicUsize::new(0));
        let counted = reads.clone();
        let app = paste_app(PasteSource::fixed(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(Pasted::Nothing)
        }));
        let url = "ghostly-svc://atlas.peer/".parse().unwrap();
        let other = WebviewWindowBuilder::new(&app, "svc-1", WebviewUrl::CustomProtocol(url))
            .build()
            .unwrap();
        assert_eq!(files(&other), Err("Not allowed from this window".into()));
        assert_eq!(
            bytes(&other, "paste-1", 10),
            Err("Not allowed from this window".into())
        );
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(files(&main_window(&app)), Ok(Vec::new()));
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        let bare = mock_builder()
            .build(tauri::generate_context!(test = true))
            .unwrap();
        assert_eq!(
            files(&main_window(&bare)),
            Err("Clipboard unavailable".into())
        );
    }

    #[test]
    fn the_shelf_keeps_the_latest_pastes_only() {
        let shelf = PasteShelf::default();
        let first = shelf.put(Held::Path(PathBuf::from("/tmp/a")));
        let tokens: Vec<String> = (0..SHELF_ITEMS)
            .map(|_| shelf.put(Held::Path(PathBuf::from("/tmp/b"))))
            .collect();
        assert!(shelf.get(&first).is_none());
        assert!(tokens.iter().all(|t| shelf.get(t).is_some()));
        // Picture bytes are bounded too: the newest one always stays.
        let big = |n: u8| Held::Bytes(Arc::new(vec![n; SHELF_BYTES / 2 + 1]));
        let (one, two) = (shelf.put(big(1)), shelf.put(big(2)));
        assert!(shelf.get(&one).is_none());
        assert!(shelf.get(&two).is_some());
    }
}
