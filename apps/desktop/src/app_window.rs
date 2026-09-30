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
}
