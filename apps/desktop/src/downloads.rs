//! The Ghostly window saves no file by itself.
//!
//! The app saves a file only through its own Save: the system's save dialog, under the file's own clean name
//! (`file_bytes_save`). On Linux WebKitGTK still starts a download of its own, with no dialog and no sign in the app:
//! its menu on a playing video has Download Video, which wrote the whole file into Downloads named after the stream's
//! token. Tauri gives the window `tauri.conf.json` makes no download rule, so it is answered here.

/// The windows the app makes, each with rules of its own: its right-click menu offers only what they let through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Window {
    /// The Ghostly window: it saves no file and opens no page (a click hands a link to the browser).
    Ghostly,
    /// A contact's app (`viewer`): it saves no file; a link or a picture elsewhere opens in the system browser.
    Contact,
    /// An installed app (`app_sandbox`): no file, no new window, no other page, and its runner loads once.
    App,
}

/// Refuses every download the main window's WebView starts, and takes WebKitGTK's own Download and Open items out of
/// its right-click menu so it offers none that would do nothing (Linux only; elsewhere the engines ask first or have
/// none).
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(|webview| linux::refuse(webview.inner()));
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// Takes the items `window`'s rules refuse out of a contact's app's or an installed app's right-click menu (Linux
/// only). Their downloads are refused already (`viewer::may_download`), but the menu is their WebView's own.
pub fn trim<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, kind: Window) {
    #[cfg(target_os = "linux")]
    let _ = window.with_webview(move |webview| linux::trim(&webview.inner(), kind));
    #[cfg(not(target_os = "linux"))]
    let _ = (window, kind);
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
        trim(&webview, super::Window::Ghostly);
        let Some(context) = webview.context() else {
            return;
        };
        context.connect_download_started(|_, download| download.cancel());
    }

    /// Takes the items `window` refuses out of the webview's menu each time it opens.
    pub fn trim(webview: &webkit2gtk::WebView, window: super::Window) {
        webview.connect_context_menu(move |_, menu, _, _| {
            drop_items(menu, window);
            false
        });
    }

    /// Takes out the menu's items that `window` refuses.
    pub(super) fn drop_items(menu: &ContextMenu, window: super::Window) {
        for item in menu.items() {
            if dead(item.stock_action(), window) {
                menu.remove(&item);
            }
        }
    }

    /// Whether `window`'s rules refuse what the item does, so it would only close the menu.
    pub(super) fn dead(action: ContextMenuAction, window: super::Window) -> bool {
        use super::Window;
        saves_a_file(action)
            || match window {
                Window::Ghostly => opens_a_page(action),
                // `on_new_window` opens an outside address in the browser, and the window goes on its own origin.
                Window::Contact => false,
                // Never a window, nowhere after the runner (`app_sandbox::may_navigate`), not even itself again.
                Window::App => opens_a_page(action) || action == ContextMenuAction::Reload,
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

    /// WebKitGTK's menu on a page where nothing else is under the pointer.
    #[cfg(target_os = "linux")]
    pub(super) const PAGE: [webkit2gtk::ContextMenuAction; 4] = {
        use webkit2gtk::ContextMenuAction as A;
        [A::GoBack, A::GoForward, A::Stop, A::Reload]
    };

    /// A contact's app and an installed app make windows of their own, whose menus WebKitGTK fills as it does the
    /// Ghostly window's: each offers only what that window's rules let through.
    #[cfg(target_os = "linux")]
    #[test]
    fn each_window_offers_only_what_its_rules_let_through() {
        // covers: desktop.window
        use super::Window;
        use webkit2gtk::ContextMenuAction as A;
        let kept = |window| -> Vec<_> {
            OFFERED
                .into_iter()
                .chain(PAGE)
                .filter(|action| !super::linux::dead(*action, window))
                .collect()
        };
        // The Ghostly window, as before: its page answers a right-click on anything but a field, a link or chosen text.
        assert_eq!(kept(Window::Ghostly), [&KEPT[..], &PAGE[..]].concat());
        // A contact's app saves no file (`viewer::may_download`); a link or a picture elsewhere opens in the browser.
        assert_eq!(
            kept(Window::Contact),
            [
                A::OpenLink,
                A::OpenLinkInNewWindow,
                A::CopyLinkToClipboard,
                A::OpenImageInNewWindow,
                A::CopyImageToClipboard,
                A::OpenFrameInNewWindow,
                A::MediaPlay,
                A::MediaMute,
                A::ToggleMediaControls,
                A::CopyVideoLinkToClipboard,
                A::OpenVideoInNewWindow,
                A::OpenAudioInNewWindow,
                A::EnterVideoFullscreen,
                A::GoBack,
                A::GoForward,
                A::Stop,
                A::Reload,
            ]
        );
        // An installed app saves no file, opens no window and no other page, and its runner loads once: no Reload.
        assert_eq!(
            kept(Window::App),
            [&KEPT[..], &[A::GoBack, A::GoForward, A::Stop][..]].concat()
        );
    }

    /// The part of `source` from `start` to the end of that function.
    fn body<'a>(source: &'a str, start: &str) -> &'a str {
        let source = &source[source.find(start).unwrap()..];
        &source[..source.find("\n}\n").unwrap()]
    }

    #[test]
    fn a_contacts_app_and_an_installed_app_trim_their_menus_too() {
        // covers: desktop.window
        assert!(body(include_str!("viewer.rs"), "pub fn open<")
            .contains("crate::downloads::trim(&window, crate::downloads::Window::Contact)"));
        assert!(body(
            include_str!("app_sandbox.rs"),
            "#[cfg(all(target_os = \"linux\", not(test)))]\nfn build_window<"
        )
        .contains("crate::downloads::trim(&window, crate::downloads::Window::App)"));
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
        let kept = |window| -> Vec<_> {
            let menu = ContextMenu::new();
            for action in super::tests::OFFERED.into_iter().chain(super::tests::PAGE) {
                menu.append(&ContextMenuItem::from_stock_action(action));
            }
            super::linux::drop_items(&menu, window);
            menu.items()
                .iter()
                .map(|item| item.stock_action())
                .collect()
        };
        let as_ruled = |window| -> Vec<_> {
            super::tests::OFFERED
                .into_iter()
                .chain(super::tests::PAGE)
                .filter(|action| !super::linux::dead(*action, window))
                .collect()
        };
        use super::Window;
        assert_eq!(
            kept(Window::Ghostly),
            [&super::tests::KEPT[..], &super::tests::PAGE[..]].concat()
        );
        for window in [Window::Contact, Window::App] {
            assert_eq!(kept(window), as_ruled(window), "{window:?}");
        }
    }
}
