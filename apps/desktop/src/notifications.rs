// macOS requires its actual authorization state; the desktop plugin's generic
// permission API unconditionally returns Granted. No notification contains chat data.
// "misplaced": the app runs from a temporary folder, where macOS gives it none (see `mac::misplaced`).

/// Where a click on a notification goes: the main window hears `notification-open` with the notification's id,
/// and finds the chat it was about (it never leaves the page). Elsewhere the plugin reports no clicks.
#[cfg(target_os = "macos")]
const OPEN_EVENT: &str = "notification-open";

/// Set up at launch: macOS tells us about clicks on our notifications.
pub fn install(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::install(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Brings the main window forward and names the notification clicked.
#[cfg(target_os = "macos")]
fn opened(app: &tauri::AppHandle, id: String) {
    use tauri::{Emitter, Manager};
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", OPEN_EVENT, id);
}

/// The system's notification settings, where notifications refused once are allowed again.
#[tauri::command]
pub fn open_notification_settings() -> Result<(), String> {
    let url = settings_url().ok_or("No notification settings to open")?;
    // The tests call every command: they never open System Settings on the machine running them.
    if cfg!(test) {
        return Ok(());
    }
    crate::commands::launch(&url)
}

#[cfg(target_os = "macos")]
fn settings_url() -> Option<String> {
    Some(mac::settings_url())
}

#[cfg(target_os = "windows")]
fn settings_url() -> Option<String> {
    Some("ms-settings:notifications".into())
}

/// Linux desktops keep notification settings in no one place.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn settings_url() -> Option<String> {
    None
}

#[tauri::command]
pub async fn native_notification_permission(request: bool) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        mac::permission(request).await.map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(None)
    }
}

#[tauri::command]
pub async fn native_private_notification(id: String, body: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if mac::permission(false).await? != "granted" {
            return Ok(true);
        }
        mac::show(&id, &body).await?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (id, body);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::*;
    use std::{
        ptr::NonNull,
        sync::{Mutex, OnceLock},
    };
    use tokio::sync::oneshot;

    /// The app's bundle, when it runs as one. A bare binary (`cargo run`, tests) has no notification center:
    /// asking for it there raises an Objective-C exception.
    fn bundle() -> Option<(String, String)> {
        let bundle = NSBundle::mainBundle();
        let id = bundle.bundleIdentifier()?.to_string();
        let path = bundle.bundlePath().to_string();
        path.trim_end_matches('/')
            .ends_with(".app")
            .then_some((path, id))
    }

    /// macOS gives no notifications to an app in a temporary folder: Launch Services marks it `in-temp-dir`,
    /// and the request fails with no dialog. That is where macOS runs a downloaded app opened before it was
    /// moved (App Translocation), and where a copy made for testing often lives.
    pub(super) fn misplaced(path: &str) -> bool {
        [
            "/private/tmp/",
            "/tmp/",
            "/private/var/folders/",
            "/var/folders/",
        ]
        .iter()
        .any(|dir| path.starts_with(dir))
            || path.contains("/AppTranslocation/")
    }

    /// `x-apple.systempreferences:` opens System Settings on its Notifications pane, at this app when the
    /// system knows the id.
    pub fn settings_url() -> String {
        let mut url =
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension".to_string();
        if let Some((_, id)) = bundle() {
            if id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            {
                url.push_str("?id=");
                url.push_str(&id);
            }
        }
        url
    }

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    define_class!(
        // The notification center's delegate: it hears which notification was clicked.
        #[unsafe(super(NSObject))]
        #[name = "GhostlyNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                if let Some(app) = APP.get() {
                    super::opened(app, id);
                }
                completion.call(());
            }
        }
    );

    pub fn install(app: &tauri::AppHandle) {
        if bundle().is_none() || APP.set(app.clone()).is_err() {
            return;
        }
        let delegate: Retained<Delegate> =
            unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center keeps only a weak reference; the delegate lives as long as the app.
        std::mem::forget(delegate);
    }

    pub async fn permission(request: bool) -> Result<String, String> {
        if bundle().is_some_and(|(path, _)| misplaced(&path)) {
            return Ok("misplaced".into());
        }
        let (tx, rx) = oneshot::channel();
        // Objective-C owns a copy of the completion block until it invokes it.
        // Only plain Rust values cross the asynchronous callback boundary.
        {
            let tx = Mutex::new(Some(tx));
            let center = UNUserNotificationCenter::currentNotificationCenter();
            if request {
                let done = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                    let result = if !error.is_null() {
                        Err("Notification authorization unavailable".to_string())
                    } else {
                        Ok(if granted.as_bool() {
                            "granted"
                        } else {
                            "denied"
                        }
                        .to_string())
                    };
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(result);
                    }
                });
                center.requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert,
                    &done,
                );
            } else {
                let done = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                    // Apple guarantees settings remains valid for this callback.
                    let status = unsafe { settings.as_ref() }.authorizationStatus();
                    let value = match status {
                        UNAuthorizationStatus::Authorized
                        | UNAuthorizationStatus::Provisional
                        | UNAuthorizationStatus::Ephemeral => "granted",
                        UNAuthorizationStatus::Denied => "denied",
                        _ => "default",
                    };
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(Ok(value.to_string()));
                    }
                });
                center.getNotificationSettingsWithCompletionHandler(&done);
            }
        }
        rx.await
            .map_err(|_| "Notification authorization unavailable".to_string())?
    }

    pub async fn show(id: &str, body: &str) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        {
            let tx = Mutex::new(Some(tx));
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str("Ghostly"));
            content.setBody(&NSString::from_str(body));
            content.setSound(None); // Sound preference belongs exclusively to the local audio controller.
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(id),
                &content,
                None,
            );
            let done = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    Ok(())
                } else {
                    Err("Notification delivery unavailable".to_string())
                };
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(result);
                }
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&done));
        }
        rx.await
            .map_err(|_| "Notification delivery unavailable".to_string())?
    }
}

#[cfg(test)]
mod settings_tests {
    // covers: desktop.notifications
    /// macOS opens its Notifications pane, Windows its notification settings; Linux has no one place.
    #[test]
    fn names_the_system_notification_settings() {
        let url = super::settings_url();
        #[cfg(target_os = "macos")]
        assert!(url
            .unwrap()
            .starts_with("x-apple.systempreferences:com.apple.Notifications-Settings.extension"));
        #[cfg(target_os = "windows")]
        assert_eq!(url.as_deref(), Some("ms-settings:notifications"));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(url, None);
    }

    /// A temporary folder, or where macOS runs a downloaded app from before it is moved: no notifications.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_app_in_a_temporary_folder_is_misplaced() {
        use super::mac::misplaced;
        for path in [
            "/private/tmp/scratch/Ghostly Chat a.app",
            "/tmp/Ghostly.app",
            "/private/var/folders/yz/abc/T/ghostly-mac-a-1/Ghostly-a.app",
            "/var/folders/yz/abc/T/Ghostly.app",
            "/private/var/folders/yz/abc/X/AppTranslocation/0A1B/d/Ghostly.app",
        ] {
            assert!(misplaced(path), "{path}");
        }
        for path in [
            "/Applications/Ghostly.app",
            "/Users/someone/Applications/Ghostly.app",
            "/Users/someone/Downloads/Ghostly.app",
            "/Volumes/Ghostly/Ghostly.app",
        ] {
            assert!(!misplaced(path), "{path}");
        }
    }
}

/// Off macOS the notification plugin decides, and nothing is shown from here.
#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    #[tokio::test]
    async fn leaves_permission_and_display_to_the_plugin() {
        assert_eq!(super::native_notification_permission(true).await, Ok(None));
        assert_eq!(
            super::native_private_notification("1".into(), "a message".into()).await,
            Ok(false)
        );
    }
}
