//! Files dragged onto the Ghostly window from a file manager, on Linux.
//!
//! WebKitGTK hands the page a file manager's drag as `text/uri-list` only: no `File`, and an empty `getData` (the
//! window's own `dragDropEnabled` is off, so the page's drops stay the page's). The drop on a chat did nothing, and on
//! the message field it wrote the file's `file://` address into the draft. Here the window watches its WebView's drags:
//! one from another app that names files on this machine is said to the page (`file-drag`, true while it is over the
//! window), which then takes it as files: on a chat the window picks them on the page's own file input
//! (`choose_dropped_files`), Files read from the disk as + → Document's, of any size; elsewhere (Join's QR picture) they
//! go on the paste shelf, and the page reads them by token (`read_dropped_files`) as a paste's. The page never sees a
//! path. A drag that starts in the page itself (a link, a picture) or in a web page is never files: only another app's
//! drag counts, as only a file manager's copy counts on the clipboard (`copied_files`).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::clipboard::{pasted_files, shelve_files, PasteShelf, PastedItem};

/// The event the page hears while another app's drag of files is over the window (true), and when it left (false).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const DRAG_EVENT: &str = "file-drag";

/// How long a drop's files wait for the page: it asks as its drop event runs, a moment later.
const FRESH: Duration = Duration::from_secs(10);

/// The `accept` of the page's own file input that the window picks a drop's files on (`choose_dropped_files`): no file
/// type, a mark. A chooser for any other input (+ → Document) is the system's dialog, as always.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
const DROP_CHOOSER: &str = "application/x-ghostly-dropped-files";

/// Clicks that input as the app: WebKit opens a file chooser only for a click a person made, and a drop is none.
const CHOOSE_SCRIPT: &str = "document.getElementById('ghostly-dropped-files')?.click()";

/// The files of the latest drop from another app, until the page takes them, once; and those it asked to have picked
/// on its file input, until the input's chooser takes them, once.
#[derive(Default)]
pub struct DroppedFiles {
    latest: Mutex<Option<(Vec<PathBuf>, Instant)>>,
    chosen: Mutex<Option<(Vec<PathBuf>, Instant)>>,
}

/// What was put a moment ago, taken; nothing after that, nor a second time.
fn take_fresh(slot: &Mutex<Option<(Vec<PathBuf>, Instant)>>) -> Vec<PathBuf> {
    match slot.lock().unwrap().take() {
        Some((paths, at)) if at.elapsed() <= FRESH => paths,
        _ => Vec::new(),
    }
}

impl DroppedFiles {
    #[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
    fn put(&self, paths: Vec<PathBuf>, at: Instant) {
        *self.latest.lock().unwrap() = Some((paths, at));
    }

    /// The latest drop's files, if it was a moment ago; nothing after that, nor a second time.
    fn take(&self) -> Vec<PathBuf> {
        take_fresh(&self.latest)
    }

    /// The files the drop chooser picks, if the page asked a moment ago; nothing after that, nor a second time.
    #[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
    fn take_chosen(&self) -> Vec<PathBuf> {
        take_fresh(&self.chosen)
    }
}

/// Whether a file chooser is the page's drop input's (`DROP_CHOOSER` its one type), which the window answers itself.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn is_drop_chooser<S: AsRef<str>>(types: &[S]) -> bool {
    matches!(types, [only] if only.as_ref() == DROP_CHOOSER)
}

/// Names only a web engine gives a drag's targets: a page's drag, whatever its list says. Chromium marks every drag a
/// page started (`x-renderer-taint`), Firefox and WebKitGTK keep a page's own types in a target of theirs. Measured
/// on Xvfb: neither browser hands over a page's `text/uri-list` today (Chromium makes a `file:` one a `text/x-moz-url`),
/// and the day one does, the list stays a link: a page must never name the files this window reads.
const WEB_PAGE_TARGETS: [&str; 3] = ["chromium/", "application/x-moz-", "org.webkitgtk.WebKit."];

/// Whether a drag with these targets comes from a web page.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub fn from_a_web_page<S: AsRef<str>>(targets: &[S]) -> bool {
    targets.iter().any(|target| {
        WEB_PAGE_TARGETS
            .iter()
            .any(|web| target.as_ref().starts_with(web))
    })
}

/// The files a drag's `text/uri-list` names on this machine: `file:` addresses with no host (or `localhost`), in
/// their order. A link, or a file on another host, is none.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub fn local_files<S: AsRef<str>>(uris: &[S]) -> Vec<PathBuf> {
    uris.iter()
        .filter_map(|uri| {
            let url = url::Url::parse(uri.as_ref().trim()).ok()?;
            if url.scheme() != "file" {
                return None;
            }
            match url.host_str() {
                None | Some("") | Some("localhost") => url.to_file_path().ok(),
                Some(_) => None,
            }
        })
        .collect()
}

/// The files of the drop the page just took, on the shelf (regular files only, as a paste's): read by token
/// (`read_pasted_bytes`), let go with `incoming_share_done`. Empty when no drop of files came from another app.
#[tauri::command]
pub async fn read_dropped_files<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<Vec<PastedItem>, String> {
    if window.label() != "main" {
        return Err("Not allowed from this window".into());
    }
    let paths = window
        .try_state::<DroppedFiles>()
        .map(|dropped| dropped.take())
        .unwrap_or_default();
    let files = tauri::async_runtime::spawn_blocking(move || pasted_files(paths))
        .await
        .map_err(|e| e.to_string())?;
    let shelf = window
        .try_state::<PasteShelf>()
        .ok_or("Clipboard unavailable")?;
    Ok(shelve_files(&shelf, files))
}

/// The files of the drop the page just took, picked on its own file input (regular files only, as a paste's): the page
/// gets Files WebKit reads from the disk as they are sent, as + → Document's, of any size, where a read by token
/// (`read_dropped_files`) brings every byte into the page first. How many are picked: 0, and nothing is clicked, when
/// the drop brought no file to send.
#[tauri::command]
pub async fn choose_dropped_files<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<usize, String> {
    if window.label() != "main" {
        return Err("Not allowed from this window".into());
    }
    let dropped = window
        .try_state::<DroppedFiles>()
        .ok_or("Dropping files is unavailable")?;
    let paths = dropped.take();
    let files = tauri::async_runtime::spawn_blocking(move || pasted_files(paths))
        .await
        .map_err(|e| e.to_string())?;
    if files.is_empty() {
        return Ok(0);
    }
    let count = files.len();
    *dropped.chosen.lock().unwrap() = Some((
        files.into_iter().map(|(path, ..)| path).collect(),
        Instant::now(),
    ));
    window.eval(CHOOSE_SCRIPT).map_err(|e| e.to_string())?;
    Ok(count)
}

/// Watches the main window's drags (Linux only: elsewhere the WebView hands the page the dropped files itself).
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    {
        let main = window.clone();
        let _ = window.with_webview(move |webview| linux::watch(webview.inner(), main));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{from_a_web_page, is_drop_chooser, local_files, DroppedFiles, DRAG_EVENT};
    use gtk::prelude::{DragContextExtManual, WidgetExt};
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::time::Instant;
    use tauri::{Emitter, Manager};
    use webkit2gtk::{FileChooserRequestExt, WebViewExt};

    /// What the drag over the window brings: the files it names when it comes from another app.
    #[derive(Default)]
    struct Drag {
        files: RefCell<Vec<PathBuf>>,
        /// What the page was last told.
        said: Cell<bool>,
        /// The drag ended in a drop (GTK says it left first).
        dropped: Cell<bool>,
    }

    /// Runs before WebKit's own handlers (GTK's drag signals run the class's last), and leaves every drag to it: the
    /// page decides where a drop goes, and cancels it there (`MessageInput`), so WebKit never writes its address.
    pub fn watch<R: tauri::Runtime>(webview: webkit2gtk::WebView, main: tauri::WebviewWindow<R>) {
        let drag = Rc::new(Drag::default());
        let app = main.app_handle().clone();

        // The page's drop input (`choose_dropped_files`): the drop's files, never a dialog. Any other input's chooser
        // goes on to WebKit's own, the system's dialog.
        {
            let app = app.clone();
            webview.connect_run_file_chooser(move |_, request| {
                if !is_drop_chooser(&request.mime_types()) {
                    return false;
                }
                let paths = app
                    .try_state::<DroppedFiles>()
                    .map(|dropped| dropped.take_chosen())
                    .unwrap_or_default();
                let paths: Vec<&str> = paths.iter().filter_map(|path| path.to_str()).collect();
                if paths.is_empty() {
                    request.cancel();
                } else {
                    request.select_files(&paths);
                }
                true
            });
        }
        let tell = {
            let drag = drag.clone();
            move |over: bool| {
                if drag.said.replace(over) != over {
                    let _ = main.emit_to("main", DRAG_EVENT, over);
                }
            }
        };
        let tell = Rc::new(tell);

        // WebKit asks for a drag's data as it enters, before the page hears of it.
        {
            let (drag, tell) = (drag.clone(), tell.clone());
            webview.connect_drag_data_received(move |_, context, _, _, data, _, _| {
                if data.target().name() != "text/uri-list" {
                    return;
                }
                // A drag the page started (a link, a picture in a chat), or any window of this app, has a source
                // widget here; a web page's, a browser's targets.
                let targets: Vec<_> = context.list_targets().iter().map(|t| t.name()).collect();
                let files =
                    if context.drag_get_source_widget().is_none() && !from_a_web_page(&targets) {
                        local_files(&data.uris())
                    } else {
                        Vec::new()
                    };
                drag.dropped.set(false);
                tell(!files.is_empty());
                *drag.files.borrow_mut() = files;
            });
        }

        {
            let drag = drag.clone();
            webview.connect_drag_drop(move |_, _, _, _, _| {
                let files = std::mem::take(&mut *drag.files.borrow_mut());
                drag.dropped.set(true);
                // The page clears its own note as it takes the drop: telling it now could reach it first.
                drag.said.set(false);
                if !files.is_empty() {
                    if let Some(dropped) = app.try_state::<DroppedFiles>() {
                        dropped.put(files, Instant::now());
                    }
                }
                false
            });
        }

        // GTK says a drag left before it says it dropped: whether it did is known once both are in.
        webview.connect_drag_leave(move |_, _, _| {
            drag.dropped.set(false);
            let (drag, tell) = (drag.clone(), tell.clone());
            gtk::glib::idle_add_local_once(move || {
                if !drag.dropped.get() {
                    drag.files.borrow_mut().clear();
                    tell(false);
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    // covers: app.composer.paste-files
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    #[test]
    fn a_file_managers_list_names_its_files_and_nothing_else() {
        assert_eq!(
            local_files(&[
                "file:///home/ana/Pictures/photo.png",
                "file:///home/ana/relat%C3%B3rio%20final%20a%C3%A7%C3%A3o.txt",
                "file://localhost/home/ana/a%20folder",
                "https://example.com/photo.png",
                "file://nas.local/share/photo.png",
                "ghostly://join#abc",
                "not an address",
                "",
            ]),
            vec![
                PathBuf::from("/home/ana/Pictures/photo.png"),
                PathBuf::from("/home/ana/relatório final ação.txt"),
                PathBuf::from("/home/ana/a folder"),
            ]
        );
        // A name of its own that ends in a carriage return stays whole; the list's own line end is gone already.
        assert_eq!(
            local_files(&["file:///home/ana/twin.txt%0D"]),
            vec![PathBuf::from("/home/ana/twin.txt\r")]
        );
    }

    #[test]
    fn a_drag_a_web_page_made_is_never_files() {
        // What Chromium and Firefox offered for a page's drag naming a file (Xvfb, 2026-11-03), and WebKitGTK's own.
        for page in [
            &[
                "text/x-moz-url",
                "UTF8_STRING",
                "STRING",
                "TEXT",
                "text/plain",
                "_NETSCAPE_URL",
                "chromium/x-renderer-taint",
                "chromium/x-web-custom-data",
            ][..],
            &["application/x-moz-custom-clipdata"],
            &[
                "text/uri-list",
                "org.webkitgtk.WebKit.custom-pasteboard-data",
            ],
        ] {
            assert!(from_a_web_page(page), "{page:?}");
        }
        // A file manager's (GTK 3 source as Thunar, Nautilus, Dolphin).
        for file_manager in [
            &["text/uri-list"][..],
            &[
                "application/vnd.portal.filetransfer",
                "application/vnd.portal.files",
                "text/uri-list",
                "text/plain;charset=utf-8",
            ],
            &[
                "text/uri-list",
                "application/x-kde4-urilist",
                "text/x-moz-url",
                "text/plain",
            ],
            &["x-special/gnome-icon-list", "text/uri-list", "UTF8_STRING"],
        ] {
            assert!(!from_a_web_page(file_manager), "{file_manager:?}");
        }
    }

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(PasteShelf::default())
            .manage(DroppedFiles::default())
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    fn read(window: &tauri::WebviewWindow<MockRuntime>) -> Result<Vec<PastedItem>, String> {
        tauri::async_runtime::block_on(read_dropped_files(window.clone()))
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ghostly-drop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The page reads a drop's files by token, as a paste's: regular files only, once, and a moment after the drop.
    #[test]
    fn a_drop_is_read_once_by_the_ghostly_window_by_token() {
        let dir = scratch();
        std::fs::write(dir.join("ghost story.txt"), b"boo").unwrap();
        std::fs::create_dir_all(dir.join("a folder")).unwrap();
        let app = app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        assert_eq!(read(&main), Ok(Vec::new()), "no drop yet");

        let dropped = app.state::<DroppedFiles>();
        dropped.put(
            vec![dir.join("ghost story.txt"), dir.join("a folder")],
            Instant::now(),
        );
        let url = "ghostly-svc://atlas.peer/".parse().unwrap();
        let other = WebviewWindowBuilder::new(&app, "svc-1", WebviewUrl::CustomProtocol(url))
            .build()
            .unwrap();
        assert_eq!(read(&other), Err("Not allowed from this window".into()));

        let items = read(&main).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            (
                items[0].name.as_deref(),
                items[0].size,
                items[0].mime.as_deref()
            ),
            (Some("ghost story.txt"), 3, None)
        );
        let bytes = tauri::async_runtime::block_on(crate::clipboard::read_pasted_bytes(
            main.clone(),
            items[0].token.clone(),
            0,
            64,
        ))
        .unwrap();
        match tauri::ipc::IpcResponse::body(bytes).unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(raw) => assert_eq!(raw, b"boo"),
            other => panic!("not raw bytes: {other:?}"),
        }
        assert_eq!(read(&main), Ok(Vec::new()), "taken once");

        // A drop the page never asked for in time is gone.
        dropped.put(
            vec![dir.join("ghost story.txt")],
            Instant::now().checked_sub(FRESH * 2).unwrap(),
        );
        assert_eq!(read(&main), Ok(Vec::new()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A drop's files over the page's read limit are picked on its file input, as + → Document's: only the drop's
    /// regular files, once, for the Ghostly window; only the drop input's chooser takes them, never another one's.
    #[test]
    fn a_drop_is_picked_once_on_the_pages_drop_input() {
        // Not under `scratch()`, which the test beside this one removes as it ends.
        let dir = std::env::temp_dir().join(format!("ghostly-choose-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("a folder")).unwrap();
        std::fs::write(dir.join("archive 300.bin"), b"large").unwrap();
        let app = app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let choose = |window: &tauri::WebviewWindow<MockRuntime>| {
            tauri::async_runtime::block_on(choose_dropped_files(window.clone()))
        };
        let dropped = app.state::<DroppedFiles>();
        assert_eq!(choose(&main), Ok(0), "no drop yet");
        assert!(dropped.take_chosen().is_empty());

        dropped.put(
            vec![dir.join("archive 300.bin"), dir.join("a folder")],
            Instant::now(),
        );
        let url = "ghostly-svc://atlas.peer/".parse().unwrap();
        let other = WebviewWindowBuilder::new(&app, "svc-1", WebviewUrl::CustomProtocol(url))
            .build()
            .unwrap();
        assert_eq!(choose(&other), Err("Not allowed from this window".into()));
        assert_eq!(choose(&main), Ok(1));
        assert_eq!(read(&main), Ok(Vec::new()), "the drop is taken");
        assert_eq!(dropped.take_chosen(), vec![dir.join("archive 300.bin")]);
        assert!(dropped.take_chosen().is_empty(), "picked once");

        // A folder alone: nothing to pick, and nothing clicked.
        dropped.put(vec![dir.join("a folder")], Instant::now());
        assert_eq!(choose(&main), Ok(0));
        assert!(dropped.take_chosen().is_empty());

        assert!(is_drop_chooser(&["application/x-ghostly-dropped-files"]));
        for other in [
            &[][..],
            &["image/*"],
            &["application/x-ghostly-dropped-files", "image/*"],
        ] {
            assert!(!is_drop_chooser(other), "{other:?}");
        }
        // The page clicks the input the window picks on.
        assert!(
            include_str!("../../ui/src/lib/pastedFiles.ts").contains(&format!(
                "DROP_INPUT_ID = \"{}\"",
                CHOOSE_SCRIPT.split('\'').nth(1).unwrap()
            ))
        );
        assert!(include_str!("../../ui/src/lib/pastedFiles.ts")
            .contains(&format!("DROP_INPUT_ACCEPT = \"{DROP_CHOOSER}\"")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// `run` is what the person's app is built from: the watch goes on its Ghostly window.
    #[test]
    fn the_app_watches_the_ghostly_windows_drags() {
        let run = include_str!("lib.rs");
        let run = &run[run.find("pub fn run()").unwrap()..];
        let run = &run[..run.find("\n}\n").unwrap()];
        assert!(run.contains("dropped_files::install(&main)"));
        assert!(run.contains(".manage(dropped_files::DroppedFiles::default())"));
    }
}
