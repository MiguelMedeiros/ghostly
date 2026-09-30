//! The microphone for a voice message on Linux.
//!
//! The voice recorder asks the page's WebView for a microphone (`getUserMedia({ audio })`). WebKitGTK turns that into
//! a `permission-request` on the WebView and, when nothing answers it, denies it: every recording failed at once with
//! "Ghostly can't use the microphone", on a machine with a working microphone and nowhere to allow it (calls were
//! fine: their media runs in Rust, `native_call`). macOS asks the person itself (NSMicrophoneUsageDescription), and
//! WebView2 answers from its own prompt.
//!
//! Only the app's own page, and only a microphone: a camera or a screen stays refused, as calls capture those in Rust.

/// Whether a user-media request is granted: a microphone alone, asked by the app's own page.
#[cfg(any(target_os = "linux", test))]
pub fn grants(audio: bool, video: bool, display: bool, page: Option<&str>) -> bool {
    audio && !video && !display && page.is_some_and(is_own_page)
}

/// The page Tauri serves the app from (`tauri://localhost`), or the dev server in a debug build.
#[cfg(any(target_os = "linux", test))]
fn is_own_page(uri: &str) -> bool {
    let origin_end = |prefix: &str| {
        uri.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '#', '?']))
    };
    origin_end("tauri://localhost")
        || (cfg!(debug_assertions) && origin_end("http://localhost:5173"))
}

/// Answers the main window's microphone requests (Linux only; elsewhere the engine asks the person).
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|webview| linux::answer(webview.inner()));
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

#[cfg(target_os = "linux")]
mod linux {
    use webkit2gtk::glib::object::{Cast, ObjectExt};
    use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};

    pub fn answer(webview: webkit2gtk::WebView) {
        webview.connect_permission_request(|webview, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                return false;
            };
            // Read as properties: the typed getters sit behind webkit2gtk's version features.
            let audio: bool = media.property("is-for-audio-device");
            let video: bool = media.property("is-for-video-device");
            let display = media.find_property("is-for-display-device").is_some()
                && media.property::<bool>("is-for-display-device");
            let page = webview.uri();
            if super::grants(audio, video, display, page.as_deref()) {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    }
}

#[cfg(test)]
mod tests {
    // covers: files.voice.record
    use super::grants;

    #[test]
    fn the_apps_page_gets_a_microphone() {
        assert!(grants(true, false, false, Some("tauri://localhost")));
        assert!(grants(
            true,
            false,
            false,
            Some("tauri://localhost/#/chat/abc")
        ));
    }

    #[test]
    fn a_camera_or_a_screen_is_never_granted() {
        assert!(!grants(true, true, false, Some("tauri://localhost")));
        assert!(!grants(false, true, false, Some("tauri://localhost")));
        assert!(!grants(false, false, true, Some("tauri://localhost")));
        assert!(!grants(true, false, true, Some("tauri://localhost")));
    }

    #[test]
    fn no_other_page_gets_it() {
        assert!(!grants(true, false, false, None));
        assert!(!grants(true, false, false, Some("https://example.com")));
        assert!(!grants(
            true,
            false,
            false,
            Some("tauri://localhost.example.com")
        ));
        assert!(!grants(true, false, false, Some("tauri://localhostile")));
    }
}
