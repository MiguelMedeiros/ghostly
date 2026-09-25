use std::sync::Arc;
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

#[cfg(test)]
mod tests {
    // covers: invite.clipboard
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
}
