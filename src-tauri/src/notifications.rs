// macOS requires its actual authorization state; the desktop plugin's generic
// permission API unconditionally returns Granted. No notification contains chat data.

/// Where a click on a notification goes: the main window hears `notification-open` with the notification's id,
/// and finds the chat it was about (it never leaves the page).
pub const OPEN_EVENT: &str = "notification-open";

/// Set up at launch: macOS tells us about clicks on our notifications.
pub fn install(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::install(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Brings the main window forward and names the notification clicked.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

fn settings_url() -> Option<String> {
    #[cfg(target_os = "macos")]
    return Some(mac::settings_url());
    #[cfg(target_os = "windows")]
    return Some("ms-settings:notifications".into());
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
    use objc2_user_notifications::*;
    use std::{
        ffi::c_void,
        ptr::NonNull,
        sync::{Mutex, Once, OnceLock},
    };
    use tokio::sync::oneshot;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSRegisterURL(url: *const c_void, update: u8) -> i32;
    }

    /// The app's bundle, when it runs as one. A bare binary (`cargo run`, tests) has no notification center:
    /// asking for it there raises an Objective-C exception.
    fn bundle() -> Option<(Retained<NSURL>, String)> {
        let bundle = NSBundle::mainBundle();
        let id = bundle.bundleIdentifier()?.to_string();
        let url = bundle.bundleURL();
        let is_app = url
            .path()
            .is_some_and(|path| path.to_string().trim_end_matches('/').ends_with(".app"));
        is_app.then_some((url, id))
    }

    /// macOS answers a notification request only for an app Launch Services knows. Finder and `open` register
    /// an app as they start it; an app started by its binary (a copy run from a folder, a test build) is not,
    /// and the request fails. Registering our own bundle once makes it known wherever it runs from.
    fn register() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            if let Some((url, _)) = bundle() {
                // Toll-free bridged: an NSURL is a CFURLRef.
                unsafe { LSRegisterURL(Retained::as_ptr(&url).cast(), 1) };
            }
        });
    }

    /// `x-apple.systempreferences:` opens System Settings on its Notifications pane, at this app when the
    /// system knows the id.
    pub fn settings_url() -> String {
        let mut url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension".to_string();
        if let Some((_, id)) = bundle() {
            if id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-') {
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
        // Off the main thread: Launch Services may take a moment, and nothing asks before it is needed.
        std::thread::spawn(register);
        let delegate: Retained<Delegate> =
            unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center keeps only a weak reference; the delegate lives as long as the app.
        std::mem::forget(delegate);
    }

    pub async fn permission(request: bool) -> Result<String, String> {
        register();
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
    /// macOS opens its Notifications pane, Windows its notification settings; Linux has no one place.
    #[test]
    fn names_the_system_notification_settings() {
        let url = super::settings_url();
        #[cfg(target_os = "macos")]
        assert!(url.unwrap().starts_with(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        ));
        #[cfg(target_os = "windows")]
        assert_eq!(url.as_deref(), Some("ms-settings:notifications"));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(url, None);
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
