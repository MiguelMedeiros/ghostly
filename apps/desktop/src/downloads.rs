//! The Ghostly window saves no file by itself.
//!
//! The app saves a file only through its own Save: the system's save dialog, under the file's own clean name
//! (`file_bytes_save`). On Linux WebKitGTK still starts a download of its own, with no dialog and no sign in the app:
//! its menu on a playing video has Download Video, which wrote the whole file into Downloads named after the stream's
//! token. Tauri gives the window `tauri.conf.json` makes no download rule, so it is answered here.

/// Refuses every download the main window's WebView starts, and takes WebKitGTK's own Download and Open items out of
/// its right-click menu so it offers none that would do nothing (Linux only; elsewhere the engines ask first or have
/// none).
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|webview| linux::refuse(webview.inner()));
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

#[cfg(target_os = "linux")]
mod linux {
    use webkit2gtk::{
        ContextMenu, ContextMenuAction, ContextMenuExt, ContextMenuItemExt, DownloadExt,
        WebContextExt, WebViewExt,
    };

    /// Downloads belong to the WebView's context, which every window of the app shares (none of them sets a data
    /// folder of its own); a contact's page and an installed app refuse theirs too (`viewer::may_download`). Cancelled
    /// as soon as one starts: a link's download was seen written whole with no `decide-destination` (where wry
    /// answers) asked first. The menu's Download items would only start one of those, so they are not offered: the
    /// cancel stays a guard.
    pub fn refuse(webview: webkit2gtk::WebView) {
        webview.connect_context_menu(|_, menu, _, _| {
            drop_dead_items(menu);
            false
        });
        let Some(context) = webview.context() else {
            return;
        };
        context.connect_download_started(|_, download| download.cancel());
    }

    /// Takes out the menu's items that save a file or open a page.
    pub(super) fn drop_dead_items(menu: &ContextMenu) {
        for item in menu.items() {
            if saves_a_file(item.stock_action()) || opens_a_page(item.stock_action()) {
                menu.remove(&item);
            }
        }
    }

    /// The items that save the link, image, video or audio under the pointer to disk.
    pub(super) fn saves_a_file(action: ContextMenuAction) -> bool {
        matches!(
            action,
            ContextMenuAction::DownloadLinkToDisk
                | ContextMenuAction::DownloadImageToDisk
                | ContextMenuAction::DownloadVideoToDisk
                | ContextMenuAction::DownloadAudioToDisk
        )
    }

    /// The items that open the link, image, video, audio or frame under the pointer. The main window has no
    /// `on_new_window` (WebKitGTK's `create` is answered by no one, so no window is made) and `navigation` keeps it on
    /// its own pages, so each one only closed the menu; a click on the app's links already hands them to the browser
    /// (`open_web_link`), and Copy Link Location stays.
    pub(super) fn opens_a_page(action: ContextMenuAction) -> bool {
        matches!(
            action,
            ContextMenuAction::OpenLink
                | ContextMenuAction::OpenLinkInNewWindow
                | ContextMenuAction::OpenImageInNewWindow
                | ContextMenuAction::OpenFrameInNewWindow
                | ContextMenuAction::OpenVideoInNewWindow
                | ContextMenuAction::OpenAudioInNewWindow
        )
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

    /// WebKitGTK's menu on a playing video in a link, with an image's and an audio's items too.
    #[cfg(target_os = "linux")]
    pub(super) const OFFERED: [webkit2gtk::ContextMenuAction; 17] = {
        use webkit2gtk::ContextMenuAction as A;
        [
            A::OpenLink,
            A::OpenLinkInNewWindow,
            A::DownloadLinkToDisk,
            A::CopyLinkToClipboard,
            A::OpenImageInNewWindow,
            A::DownloadImageToDisk,
            A::CopyImageToClipboard,
            A::OpenFrameInNewWindow,
            A::MediaPlay,
            A::MediaMute,
            A::ToggleMediaControls,
            A::CopyVideoLinkToClipboard,
            A::OpenVideoInNewWindow,
            A::DownloadVideoToDisk,
            A::OpenAudioInNewWindow,
            A::DownloadAudioToDisk,
            A::EnterVideoFullscreen,
        ]
    };

    /// What is left of that menu: nothing that saves a file or opens a page, the rest in its order.
    #[cfg(target_os = "linux")]
    pub(super) const KEPT: [webkit2gtk::ContextMenuAction; 7] = {
        use webkit2gtk::ContextMenuAction as A;
        [
            A::CopyLinkToClipboard,
            A::CopyImageToClipboard,
            A::MediaPlay,
            A::MediaMute,
            A::ToggleMediaControls,
            A::CopyVideoLinkToClipboard,
            A::EnterVideoFullscreen,
        ]
    };

    #[cfg(target_os = "linux")]
    #[test]
    fn the_menu_offers_no_download_and_no_open() {
        // covers: desktop.window
        let kept: Vec<_> = OFFERED
            .into_iter()
            .filter(|action| {
                !super::linux::saves_a_file(*action) && !super::linux::opens_a_page(*action)
            })
            .collect();
        assert_eq!(kept, KEPT);
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

    #[test]
    #[ignore = "needs a display and a process of its own (GTK)"]
    fn the_real_menu_offers_no_download_and_no_open() {
        // covers: desktop.window
        use webkit2gtk::{ContextMenu, ContextMenuExt, ContextMenuItem, ContextMenuItemExt};
        // Building the app brings GTK up on this thread, as the menu's items need.
        let _app = tauri::Builder::default()
            .any_thread()
            .build(tauri::generate_context!(test = true))
            .expect("app");
        let menu = ContextMenu::new();
        for action in super::tests::OFFERED {
            menu.append(&ContextMenuItem::from_stock_action(action));
        }
        super::linux::drop_dead_items(&menu);
        let kept: Vec<_> = menu
            .items()
            .iter()
            .map(|item| item.stock_action())
            .collect();
        assert_eq!(kept, super::tests::KEPT);
    }
}
