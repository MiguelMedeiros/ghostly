//! The Ghostly window's life as a Mac app: closing it hides it and the app keeps running (messages, calls and
//! notifications go on), the Dock icon or a notification brings it back, and Cmd+Q quits. The app's menu has
//! New Chat (Cmd+N) and Settings… (Cmd+,) beside the standard Edit menu.
//!
//! Linux and Windows keep closing the window as quitting the app: they have no Dock to bring it back from, and
//! Ghostly puts no icon in their tray. There the page takes Ctrl+N and Ctrl+, itself (apps/ui/src/desktop/host.ts).

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The event the page hears a menu command on, with the command as its payload (`apps/ui/src/lib/appCommands.ts`).
pub const COMMAND_EVENT: &str = "app-command";

/// File → New Chat (Cmd+N): the chat list's New.
pub const NEW_CHAT: &str = "ghostly-new-chat";
/// Ghostly → Settings… (Cmd+,).
pub const SETTINGS: &str = "ghostly-settings";

/// The menu items that are the page's commands: (menu id, command the page runs).
const COMMANDS: &[(&str, &str)] = &[(NEW_CHAT, "new"), (SETTINGS, "settings")];

/// The command a menu item stands for, if it is one of the page's.
pub fn command_for(menu_id: &str) -> Option<&'static str> {
    COMMANDS
        .iter()
        .find(|(id, _)| *id == menu_id)
        .map(|(_, command)| *command)
}

/// Whether closing this window hides it instead: the Ghostly window, on a Mac.
pub fn hides_on_close(label: &str) -> bool {
    cfg!(target_os = "macos") && label == "main"
}

/// Puts the Ghostly window back on screen and in front: a click on the Dock icon, a menu command while it was hidden.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A close the person asked for (the red button, Cmd+W, Close Window): the Ghostly window on a Mac goes out of
/// sight and the app runs on. Out of full screen first, which would otherwise leave an empty Space behind.
pub fn on_close_requested<R: Runtime>(window: &tauri::Window<R>, api: &tauri::CloseRequestApi) {
    if !hides_on_close(window.label()) {
        return;
    }
    api.prevent_close();
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
    }
    let _ = window.hide();
}

/// A menu item was chosen: the page's commands go to the page, with the window brought back first.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let Some(command) = command_for(id) else {
        return false;
    };
    show_main(app);
    let _ = app.emit_to("main", COMMAND_EVENT, command);
    true
}

/// A title the page gives a menu item, as the menu shows it: trimmed, at most `MAX_TITLE` characters, nothing a line
/// cannot hold. An `&` is doubled, so the menu shows it instead of reading a mnemonic. None: not a title, the item
/// keeps the one it has.
#[cfg(any(target_os = "macos", test))]
pub fn menu_title(value: &str) -> Option<String> {
    let title = value.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE || title.chars().any(char::is_control)
    {
        return None;
    }
    Some(title.replace('&', "&&"))
}

/// The longest title a menu item takes from the page.
#[cfg(any(target_os = "macos", test))]
const MAX_TITLE: usize = 60;

/// Where each title the page may give sits in `menu`: (the page's key, the submenu, the item in it; none for the
/// submenu's own title). The app's own submenu keeps the app's name, which macOS shows there whatever it is called.
/// Kept in step with `menu` by e2e/desktop-macos/menu-language.spec.ts, which reads every title back.
#[cfg(any(target_os = "macos", test))]
const TITLES: &[(&str, usize, Option<usize>)] = &[
    ("about", 0, Some(0)),
    ("settings", 0, Some(2)),
    ("services", 0, Some(4)),
    ("hide", 0, Some(6)),
    ("hideOthers", 0, Some(7)),
    ("showAll", 0, Some(8)),
    ("quit", 0, Some(10)),
    ("file", 1, None),
    ("newChat", 1, Some(0)),
    ("closeWindow", 1, Some(2)),
    ("edit", 2, None),
    ("undo", 2, Some(0)),
    ("redo", 2, Some(1)),
    ("cut", 2, Some(3)),
    ("copy", 2, Some(4)),
    ("paste", 2, Some(5)),
    ("selectAll", 2, Some(6)),
    ("view", 3, None),
    ("fullScreen", 3, Some(0)),
    ("window", 4, None),
    ("minimize", 4, Some(0)),
    ("zoom", 4, Some(1)),
    ("closeWindow", 4, Some(3)),
    ("help", 5, None),
];

/// Gives the menu the page's titles (`commands::set_menu_titles`): only the keys of `TITLES` with a title `menu_title`
/// takes; anything else is left as it is.
#[cfg(target_os = "macos")]
pub fn retitle<R: Runtime>(
    app: &AppHandle<R>,
    titles: &std::collections::HashMap<String, String>,
) -> tauri::Result<()> {
    use tauri::menu::MenuItemKind;
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let submenus = menu.items()?;
    for (key, at, item) in TITLES {
        let Some(title) = titles.get(*key).and_then(|title| menu_title(title)) else {
            continue;
        };
        let Some(MenuItemKind::Submenu(submenu)) = submenus.get(*at) else {
            continue;
        };
        match item {
            None => submenu.set_text(&title)?,
            Some(index) => match submenu.items()?.get(*index) {
                Some(MenuItemKind::MenuItem(item)) => item.set_text(&title)?,
                Some(MenuItemKind::Predefined(item)) => item.set_text(&title)?,
                _ => {}
            },
        }
    }
    Ok(())
}

/// The menu bar as it stands, for the e2e driver: each submenu's title with its items' titles, separators left out.
#[cfg(any(test, feature = "e2e-driver"))]
#[cfg_attr(not(feature = "e2e-driver"), allow(dead_code))]
pub fn shown_titles<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, Vec<String>)> {
    use tauri::menu::MenuItemKind;
    let Some(menu) = app.menu() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for kind in menu.items().unwrap_or_default() {
        let MenuItemKind::Submenu(submenu) = kind else {
            continue;
        };
        let mut items = Vec::new();
        for item in submenu.items().unwrap_or_default() {
            let title = match item {
                MenuItemKind::MenuItem(item) => item.text().ok(),
                MenuItemKind::Predefined(item) => item.text().ok(),
                _ => None,
            };
            items.extend(title.filter(|title| !title.is_empty()));
        }
        out.push((submenu.text().unwrap_or_default(), items));
    }
    out
}

/// The app's menu on a Mac: Tauri's default (the app menu, File, Edit, View, Window, Help) with Settings… (Cmd+,)
/// in the app menu and New Chat (Cmd+N) in File.
#[cfg(target_os = "macos")]
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };
    let info = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let settings = MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let new_chat = MenuItem::with_id(app, NEW_CHAT, "New Chat", true, Some("CmdOrCtrl+N"))?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &new_chat,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

#[cfg(test)]
mod tests {
    // covers: desktop.window
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::{Listener, WebviewWindowBuilder};

    #[test]
    fn the_menu_items_are_the_pages_new_and_settings_and_nothing_else() {
        assert_eq!(command_for(NEW_CHAT), Some("new"));
        assert_eq!(command_for(SETTINGS), Some("settings"));
        for other in ["quit", "close_window", "copy", "", "new", "settings"] {
            assert_eq!(command_for(other), None, "{other}");
        }
    }

    #[test]
    fn only_the_ghostly_window_on_a_mac_hides_when_closed() {
        assert_eq!(hides_on_close("main"), cfg!(target_os = "macos"));
        // A contact's app in a window of its own closes for good, everywhere.
        assert!(!hides_on_close("svc-1"));
        assert!(!hides_on_close("Main"));
    }

    #[test]
    fn a_menu_command_reaches_the_ghostly_window_as_app_command() {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("app");
        let _main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let into = heard.clone();
        app.listen_any(COMMAND_EVENT, move |event| {
            into.lock().unwrap().push(event.payload().to_string());
        });
        assert!(on_menu_event(app.handle(), SETTINGS));
        assert!(on_menu_event(app.handle(), NEW_CHAT));
        // Not the page's: Tauri's own items (Quit, Copy...) do what they do, and the page hears nothing.
        assert!(!on_menu_event(app.handle(), "quit"));
        assert_eq!(*heard.lock().unwrap(), [r#""settings""#, r#""new""#]);
    }

    #[test]
    fn a_menu_title_from_the_page_is_trimmed_bounded_and_one_line() {
        assert_eq!(menu_title("  Arquivo "), Some("Arquivo".into()));
        assert_eq!(menu_title("Ajustes…"), Some("Ajustes…".into()));
        // Shown as it is, never read as a mnemonic.
        assert_eq!(menu_title("Cut & Paste"), Some("Cut && Paste".into()));
        assert_eq!(menu_title(""), None);
        assert_eq!(menu_title("   "), None);
        assert_eq!(menu_title("two\nlines"), None);
        assert_eq!(
            menu_title(&"a".repeat(MAX_TITLE)),
            Some("a".repeat(MAX_TITLE))
        );
        assert_eq!(menu_title(&"a".repeat(MAX_TITLE + 1)), None);
        // Counted in characters, not bytes.
        assert_eq!(
            menu_title(&"設".repeat(MAX_TITLE)),
            Some("設".repeat(MAX_TITLE))
        );
    }

    #[test]
    fn every_title_has_a_place_of_its_own_in_the_menu() {
        let mut places: Vec<(usize, Option<usize>)> =
            TITLES.iter().map(|(_, at, item)| (*at, *item)).collect();
        let count = places.len();
        places.sort();
        places.dedup();
        assert_eq!(places.len(), count);
        // Close Window is in File and in Window: one title for both.
        assert_eq!(
            TITLES
                .iter()
                .filter(|(key, _, _)| *key == "closeWindow")
                .count(),
            2
        );
    }
}
