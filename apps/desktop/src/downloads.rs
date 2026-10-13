//! The Ghostly window saves no file by itself.
//!
//! The app saves a file only through its own Save: the system's save dialog, under the file's own clean name
//! (`file_bytes_save`). On Linux WebKitGTK still starts a download of its own, with no dialog and no sign in the app:
//! its menu on a playing video has Download Video, which wrote the whole file into Downloads named after the stream's
//! token. Tauri gives the window `tauri.conf.json` makes no download rule, so it is answered here.

/// Refuses every download the main window's WebView starts (Linux only; elsewhere the engines ask first or have none).
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|webview| linux::refuse(webview.inner()));
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

#[cfg(target_os = "linux")]
mod linux {
    use webkit2gtk::{DownloadExt, WebContextExt, WebViewExt};

    /// Downloads belong to the WebView's context, which every window of the app shares (none of them sets a data
    /// folder of its own); a contact's page and an installed app refuse theirs too (`viewer::may_download`). Cancelled
    /// as soon as one starts: a link's download was seen written whole with no `decide-destination` (where wry
    /// answers) asked first.
    pub fn refuse(webview: webkit2gtk::WebView) {
        let Some(context) = webview.context() else {
            return;
        };
        context.connect_download_started(|_, download| download.cancel());
    }
}

#[cfg(test)]
mod tests {
    // covers: desktop.window
    /// `run` is what the person's app is built from: the rule goes on its Ghostly window.
    #[test]
    fn the_app_installs_it_on_the_ghostly_window() {
        let run = include_str!("lib.rs");
        let run = &run[run.find("pub fn run()").unwrap()..];
        let run = &run[..run.find("\n}\n").unwrap()];
        assert!(run.contains("downloads::install(&main)"));
    }
}

/// The real window on WebKitGTK: what the Ghostly window can leave on disk.
#[cfg(all(test, target_os = "linux"))]
mod download_tests {
    use tauri::Manager;

    const SCHEME: &str = "ghostly-main-probe";

    #[test]
    #[ignore = "needs a display and a process of its own (test_support::saved_by_a_window)"]
    fn a_download_the_ghostly_window_starts_saves_no_file() {
        // covers: desktop.window
        let saved = crate::test_support::saved_by_a_window(
            SCHEME,
            // The window `tauri.conf.json` makes, set up as `run` does, then on the downloading page.
            |app| {
                app.setup(|app| {
                    let main = app.get_webview_window("main").unwrap();
                    super::install(&main);
                    main.navigate(format!("{SCHEME}://localhost/").parse()?)?;
                    Ok(())
                })
            },
            |_| {},
        );
        assert_eq!(saved, Vec::<String>::new());
    }
}
