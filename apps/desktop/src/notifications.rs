// macOS requires its actual authorization state; the desktop plugin's generic
// permission API unconditionally returns Granted. No notification contains chat data.
// "misplaced": the app runs from a temporary folder, where macOS gives it none (see `mac::misplaced`).

/// Where a click on a notification goes: the main window hears `notification-open` with the notification's id,
/// and finds the chat it was about (it never leaves the page). Elsewhere the plugin reports no clicks.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const OPEN_EVENT: &str = "notification-open";

/// Set up at launch: macOS tells us about clicks on our notifications, and Linux's notifications are shown from here.
pub fn install(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::install(app);
    #[cfg(target_os = "linux")]
    linux::install(app);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = app;
}

/// Brings the main window forward and names the notification clicked.
#[cfg(any(target_os = "macos", target_os = "linux"))]
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
    // Android: the app's own page in Settings, by an intent rather than a URL.
    #[cfg(target_os = "android")]
    {
        crate::android::open_notification_settings()
    }
    #[cfg(not(target_os = "android"))]
    {
        let url = settings_url().ok_or("No notification settings to open")?;
        // The tests call every command: they never open System Settings on the machine running them.
        if cfg!(test) {
            return Ok(());
        }
        crate::commands::launch(&url)
    }
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
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
fn settings_url() -> Option<String> {
    None
}

#[tauri::command]
pub async fn native_notification_permission(request: bool) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        mac::permission(request).await.map(Some)
    }
    // Android 13 and up asks at the first `request` (POST_NOTIFICATIONS); before, notifications are on unless the
    // person turned them off in Settings.
    #[cfg(target_os = "android")]
    {
        crate::android::notification_permission(request)
            .await
            .map(Some)
    }
    #[cfg(not(any(target_os = "macos", target_os = "android")))]
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
    // Android: the app's own notification, on its Messages channel, whose tap opens the chat (android.rs).
    #[cfg(target_os = "android")]
    {
        if crate::android::notification_permission(false).await? != "granted" {
            return Ok(true);
        }
        crate::android::notify(&id, &body).await?;
        Ok(true)
    }
    // Linux: false with no notification server on the session bus, and the plugin tries.
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || linux::show(&id, &body))
            .await
            .map_err(|_| "Notification delivery unavailable".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "android", target_os = "linux")))]
    {
        let _ = (id, body);
        Ok(false)
    }
}

/// The chat of notification `id` was read in the app. Android keeps a notification until it is tapped or swiped (and
/// shows none past 50 an app posted), and a Linux desktop keeps a list of them, so it goes now; elsewhere they go by
/// themselves.
#[tauri::command]
pub async fn native_clear_notification(id: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android::cancel_notification(&id).await
    }
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || linux::clear(&id))
            .await
            .map_err(|_| "Notification delivery unavailable".to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    {
        let _ = id;
        Ok(())
    }
}

/// The page starts: the message notifications an earlier one left go. Android keeps them after the app's process
/// ends, and the page that posted them was the only one that knew their chats. Elsewhere, nothing.
#[tauri::command]
pub async fn native_clear_notifications() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android::cancel_notifications().await
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(())
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

/// Linux: our notifications go to the desktop's notification server (org.freedesktop.Notifications) from here, with
/// a `default` action, so a click on one reaches the app. The plugin offers no action, and a click only closed it.
#[cfg(target_os = "linux")]
mod linux {
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex, OnceLock};
    use zbus::blocking::{Connection, MessageIterator};
    use zbus::names::OwnedUniqueName;
    use zbus::zvariant::Value;

    const SERVER: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    /// The bus itself, which tells who owns a name.
    const BUS: &str = "org.freedesktop.DBus";
    /// The newest few, as the page keeps (lib/notifications.ts): an older one's click only closes it.
    const KEPT: usize = 64;

    /// A notification of ours: the server that showed it (its unique name on the bus), its id there and ours.
    /// A server that restarts numbers from 1 again, under another unique name.
    type Shown = (Option<OwnedUniqueName>, u32, String);

    /// One connection for every notification, and one thread that hears their clicks.
    pub(super) struct Notifier {
        connection: Connection,
        /// Our notifications not yet closed, oldest first.
        shown: Arc<Mutex<VecDeque<Shown>>>,
    }

    impl Notifier {
        /// `open` hears our id of each notification clicked.
        pub(super) fn new(
            connection: Connection,
            open: impl Fn(String) + Send + 'static,
        ) -> zbus::Result<Self> {
            // Subscribed before the first notification is shown, so no click comes before the listener.
            let rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                // Only from the notification server: another process's signal opens nothing.
                .sender(SERVER)?
                .interface(SERVER)?
                .path(PATH)?
                .build();
            let signals = MessageIterator::for_match_rule(rule, &connection, None)?;
            let shown: Arc<Mutex<VecDeque<Shown>>> = Arc::default();
            let heard = Arc::clone(&shown);
            std::thread::Builder::new()
                .name("notification-clicks".into())
                .spawn(move || {
                    for signal in signals.flatten() {
                        let header = signal.header();
                        // Both signals start with the server's id; other apps' notifications have ids not ours,
                        // and so has every notification of a server that started after ours was shown.
                        // A click on the notification's body is its `default` action.
                        let (server_id, clicked) = match header.member().map(|m| m.as_str()) {
                            Some("ActionInvoked") => match signal
                                .body()
                                .deserialize::<(u32, String)>()
                            {
                                Ok((server_id, action)) if action == "default" => (server_id, true),
                                _ => continue,
                            },
                            Some("NotificationClosed") => {
                                match signal.body().deserialize::<(u32, u32)>() {
                                    Ok((server_id, _)) => (server_id, false),
                                    Err(_) => continue,
                                }
                            }
                            _ => continue,
                        };
                        let ours = {
                            let mut shown = heard.lock().unwrap();
                            shown
                                .iter()
                                .position(|(server, id, _)| {
                                    *id == server_id && server.as_deref() == header.sender()
                                })
                                .and_then(|at| shown.remove(at))
                        };
                        if let (true, Some((_, _, id))) = (clicked, ours) {
                            open(id);
                        }
                    }
                })?;
            Ok(Self { connection, shown })
        }

        /// The server's id of our notification `id`, while it is shown, and by the server there is now: the
        /// number a server that is gone gave it is another app's notification by now, or nobody's.
        fn server_id(&self, id: &str) -> Option<u32> {
            let (shown_by, server_id) = {
                let shown = self.shown.lock().unwrap();
                let (shown_by, server_id, _) = shown.iter().find(|(_, _, ours)| ours == id)?;
                (shown_by.clone()?, *server_id)
            };
            let owner = self
                .connection
                .call_method(
                    Some(BUS),
                    "/org/freedesktop/DBus",
                    Some(BUS),
                    "GetNameOwner",
                    &SERVER,
                )
                .ok()?;
            let owner: OwnedUniqueName = owner.body().deserialize().ok()?;
            (owner == shown_by).then_some(server_id)
        }

        /// Shown again under the same `id` (a chat's next messages), it takes the place of the one still there.
        pub(super) fn show(&self, id: &str, body: &str) -> zbus::Result<()> {
            let replaces = self.server_id(id).unwrap_or(0);
            // The installed app's desktop entry and icon (Ghostly.desktop, ghostly.png); the sound stays the
            // local audio controller's, as on macOS.
            let hints = HashMap::from([
                ("desktop-entry", Value::from("Ghostly")),
                ("suppress-sound", Value::from(true)),
            ]);
            let actions = ["default", "Ghostly"];
            let reply = self.connection.call_method(
                Some(SERVER),
                PATH,
                Some(SERVER),
                "Notify",
                &(
                    "Ghostly",
                    replaces,
                    "ghostly",
                    "Ghostly",
                    body,
                    &actions[..],
                    hints,
                    -1i32,
                ),
            )?;
            let server_id: u32 = reply.body().deserialize()?;
            let server = reply.header().sender().map(|name| name.to_owned().into());
            let mut shown = self.shown.lock().unwrap();
            // A server that is gone closes nothing: what it showed is forgotten at the next one's first.
            // Newest last, and once: the one it replaced is this one now.
            shown.retain(|(shown_by, theirs, ours)| {
                *shown_by == server && *theirs != server_id && ours != id
            });
            shown.push_back((server, server_id, id.to_string()));
            if shown.len() > KEPT {
                shown.pop_front();
            }
            Ok(())
        }

        /// Takes our notification `id` back from the server; nothing when it is gone already.
        pub(super) fn clear(&self, id: &str) -> zbus::Result<()> {
            let server_id = self.server_id(id);
            self.shown.lock().unwrap().retain(|(_, _, ours)| ours != id);
            let Some(server_id) = server_id else {
                return Ok(());
            };
            self.connection
                .call_method(
                    Some(SERVER),
                    PATH,
                    Some(SERVER),
                    "CloseNotification",
                    &server_id,
                )
                .map(drop)
        }
    }

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// Connected at the first notification; tried again at the next one while there is no session bus.
    static NOTIFIER: Mutex<Option<Notifier>> = Mutex::new(None);

    pub fn install(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
    }

    /// False when it could not be shown from here (no app yet, no session bus, no notification server).
    pub fn show(id: &str, body: &str) -> bool {
        let Some(app) = APP.get() else {
            return false;
        };
        let mut notifier = NOTIFIER.lock().unwrap();
        if notifier.is_none() {
            let app = app.clone();
            *notifier = Connection::session()
                .and_then(|connection| Notifier::new(connection, move |id| super::opened(&app, id)))
                .ok();
        }
        match notifier.as_ref().map(|notifier| notifier.show(id, body)) {
            Some(Ok(())) => true,
            // The bus answered (no notification server, or it refused): the connection is good.
            Some(Err(zbus::Error::MethodError(..))) | None => false,
            // A connection that broke is not kept: its listener ends with it, and the next notification connects again.
            Some(Err(_)) => {
                *notifier = None;
                false
            }
        }
    }

    /// Nothing before the first notification was shown from here: there is none to take back.
    pub fn clear(id: &str) {
        let mut notifier = NOTIFIER.lock().unwrap();
        let cleared = notifier.as_ref().map(|notifier| notifier.clear(id));
        // As in `show`: a connection that broke is not kept.
        if matches!(&cleared, Some(Err(error)) if !matches!(error, zbus::Error::MethodError(..))) {
            *notifier = None;
        }
    }

    #[cfg(test)]
    mod tests {
        // covers: desktop.notifications
        use super::*;
        use std::io::{BufRead, BufReader};
        use std::process::{Child, Command, Stdio};
        use std::sync::mpsc;
        use std::time::Duration;
        use zbus::zvariant::OwnedValue;

        /// A session bus of the test's own, gone with it.
        struct Bus(Child, String);

        impl Bus {
            fn start() -> Self {
                let mut daemon = Command::new("dbus-daemon")
                    .args(["--session", "--nofork", "--print-address"])
                    .stdout(Stdio::piped())
                    .spawn()
                    .expect("dbus-daemon");
                let mut address = String::new();
                BufReader::new(daemon.stdout.take().unwrap())
                    .read_line(&mut address)
                    .unwrap();
                Bus(daemon, address.trim().to_string())
            }

            fn connect(&self) -> zbus::blocking::connection::Builder<'static> {
                zbus::blocking::connection::Builder::address(self.1.as_str()).unwrap()
            }
        }

        impl Drop for Bus {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        type Notified = (
            String,
            String,
            String,
            Vec<String>,
            HashMap<String, OwnedValue>,
        );

        /// A notification server: it numbers each notification and passes on what it was asked to show.
        struct Server(mpsc::Sender<Notified>, u32);

        #[zbus::interface(name = "org.freedesktop.Notifications")]
        impl Server {
            #[allow(clippy::too_many_arguments)]
            fn notify(
                &mut self,
                app_name: String,
                _replaces_id: u32,
                icon: String,
                _summary: String,
                body: String,
                actions: Vec<String>,
                hints: HashMap<String, OwnedValue>,
                _timeout: i32,
            ) -> u32 {
                self.1 += 1;
                let _ = self.0.send((app_name, icon, body, actions, hints));
                self.1
            }
        }

        /// A notification server that keeps a list, as GNOME, KDE and swaync do: what it still shows, by its id.
        struct Listing(Arc<Mutex<Vec<(u32, String)>>>, u32);

        #[zbus::interface(name = "org.freedesktop.Notifications")]
        impl Listing {
            #[allow(clippy::too_many_arguments)]
            fn notify(
                &mut self,
                _app_name: String,
                replaces_id: u32,
                _icon: String,
                _summary: String,
                body: String,
                _actions: Vec<String>,
                _hints: HashMap<String, OwnedValue>,
                _timeout: i32,
            ) -> u32 {
                let mut shown = self.0.lock().unwrap();
                if let Some(kept) = shown.iter_mut().find(|(id, _)| *id == replaces_id) {
                    kept.1 = body;
                    return replaces_id;
                }
                self.1 += 1;
                shown.push((self.1, body));
                self.1
            }

            fn close_notification(&mut self, id: u32) {
                self.0.lock().unwrap().retain(|(shown, _)| *shown != id);
            }
        }

        /// A chat's notifications used to pile up in the desktop's list, each burst a new one, and none was taken
        /// back. Now a chat has one, which its next burst replaces, and reading the chat closes it.
        #[test]
        fn a_chat_has_one_notification_until_it_is_read() {
            let bus = Bus::start();
            let listed: Arc<Mutex<Vec<(u32, String)>>> = Arc::default();
            let _server = bus
                .connect()
                .name(SERVER)
                .unwrap()
                .serve_at(PATH, Listing(Arc::clone(&listed), 0))
                .unwrap()
                .build()
                .unwrap();
            let notifier = Notifier::new(bus.connect().build().unwrap(), |_| {}).unwrap();
            let listed = || listed.lock().unwrap().clone();

            notifier.show("chat-a", "first burst").unwrap();
            notifier.show("chat-b", "another chat").unwrap();
            notifier.show("chat-a", "second burst").unwrap();
            notifier.show("chat-a", "third burst").unwrap();
            assert_eq!(
                listed(),
                [
                    (1, "third burst".to_string()),
                    (2, "another chat".to_string())
                ]
            );

            // Read in the app: only that chat's goes, and once.
            notifier.clear("chat-a").unwrap();
            assert_eq!(listed(), [(2, "another chat".to_string())]);
            notifier.clear("chat-a").unwrap();
            notifier.clear("never-shown").unwrap();
            assert_eq!(listed(), [(2, "another chat".to_string())]);

            // Its next message is a new notification, which replaces none of another chat's.
            notifier.show("chat-a", "after it was read").unwrap();
            assert_eq!(
                listed(),
                [
                    (2, "another chat".to_string()),
                    (3, "after it was read".to_string())
                ]
            );
            notifier.clear("chat-b").unwrap();
            notifier.clear("chat-a").unwrap();
            assert_eq!(listed(), []);
        }

        /// The click the issue measured as lost: the server offers the body as the `default` action, and its
        /// click names the notification, while another app's, a closed one and a second click open nothing.
        #[test]
        fn a_click_on_a_notification_names_it() {
            let bus = Bus::start();
            let (notified, asked) = mpsc::channel();
            let server = bus
                .connect()
                .name(SERVER)
                .unwrap()
                .serve_at(PATH, Server(notified, 0))
                .unwrap()
                .build()
                .unwrap();
            let (opened, open) = mpsc::channel();
            let notifier = Notifier::new(bus.connect().build().unwrap(), move |id| {
                let _ = opened.send(id);
            })
            .unwrap();
            notifier.show("event-1", "New message").unwrap();
            notifier.show("event-2", "New message").unwrap();

            let (app_name, icon, body, actions, hints) = asked.recv().unwrap();
            assert_eq!(
                (app_name.as_str(), icon.as_str(), body.as_str()),
                ("Ghostly", "ghostly", "New message")
            );
            assert_eq!(actions.first().map(String::as_str), Some("default"));
            assert_eq!(
                String::try_from(hints["desktop-entry"].try_clone().unwrap()).unwrap(),
                "Ghostly"
            );
            assert!(bool::try_from(&hints["suppress-sound"]).unwrap());

            let signal = |name: &str, body: &(u32, &str)| {
                server
                    .emit_signal(None::<()>, PATH, SERVER, name, body)
                    .unwrap()
            };
            signal("ActionInvoked", &(99, "default"));
            // Another process on the bus plays a click on ours: not the server, so it opens nothing.
            bus.connect()
                .build()
                .unwrap()
                .emit_signal(
                    None::<()>,
                    PATH,
                    SERVER,
                    "ActionInvoked",
                    &(1u32, "default"),
                )
                .unwrap();
            signal("ActionInvoked", &(2, "reply"));
            server
                .emit_signal(
                    None::<()>,
                    PATH,
                    SERVER,
                    "NotificationClosed",
                    &(1u32, 2u32),
                )
                .unwrap();
            signal("ActionInvoked", &(1, "default"));
            signal("ActionInvoked", &(2, "default"));
            assert_eq!(
                open.recv_timeout(Duration::from_secs(10)).unwrap(),
                "event-2"
            );
            signal("ActionInvoked", &(2, "default"));
            assert!(open.recv_timeout(Duration::from_millis(500)).is_err());
        }

        /// A server that restarts (mako, dunst, a reloaded shell) numbers from 1 again: a click on its number 2,
        /// another app's now, opens nothing, and ours shown since then still open.
        #[test]
        fn a_restarted_server_s_numbers_are_not_ours() {
            let bus = Bus::start();
            let serve = || {
                let (notified, _asked) = mpsc::channel();
                bus.connect()
                    .name(SERVER)
                    .unwrap()
                    .serve_at(PATH, Server(notified, 0))
                    .unwrap()
                    .build()
                    .unwrap()
            };
            let server = serve();
            let (opened, open) = mpsc::channel();
            let notifier = Notifier::new(bus.connect().build().unwrap(), move |id| {
                let _ = opened.send(id);
            })
            .unwrap();
            notifier.show("event-1", "New message").unwrap();
            notifier.show("event-2", "New message").unwrap();

            // It dies with no NotificationClosed.
            drop(server);
            let server = serve();
            let click = |id: u32| {
                server
                    .emit_signal(None::<()>, PATH, SERVER, "ActionInvoked", &(id, "default"))
                    .unwrap()
            };
            click(2);
            notifier.show("event-3", "New message").unwrap();
            click(1);
            assert_eq!(
                open.recv_timeout(Duration::from_secs(10)).unwrap(),
                "event-3"
            );
            assert!(open.recv_timeout(Duration::from_millis(500)).is_err());
        }

        /// The same numbers are never sent back to the new server: a chat's next burst replaces none of another
        /// app's notifications there, and a chat read closes none.
        #[test]
        fn a_restarted_server_keeps_the_other_apps_notifications() {
            let bus = Bus::start();
            let serve = |listed: &Arc<Mutex<Vec<(u32, String)>>>| {
                bus.connect()
                    .name(SERVER)
                    .unwrap()
                    .serve_at(PATH, Listing(Arc::clone(listed), 0))
                    .unwrap()
                    .build()
                    .unwrap()
            };
            let server = serve(&Arc::default());
            let notifier = Notifier::new(bus.connect().build().unwrap(), |_| {}).unwrap();
            notifier.show("chat-a", "first burst").unwrap();
            notifier.show("chat-b", "another chat").unwrap();

            drop(server);
            let listed: Arc<Mutex<Vec<(u32, String)>>> = Arc::default();
            let _server = serve(&listed);
            let other = bus.connect().build().unwrap();
            for body in ["its first", "its second"] {
                let (actions, hints) = (Vec::<String>::new(), HashMap::<String, OwnedValue>::new());
                other
                    .call_method(
                        Some(SERVER),
                        PATH,
                        Some(SERVER),
                        "Notify",
                        &("Other", 0u32, "", "Other", body, actions, hints, -1i32),
                    )
                    .unwrap();
            }

            notifier.clear("chat-b").unwrap();
            notifier.show("chat-a", "second burst").unwrap();
            assert_eq!(
                listed.lock().unwrap().clone(),
                [
                    (1, "its first".to_string()),
                    (2, "its second".to_string()),
                    (3, "second burst".to_string())
                ]
            );
        }
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

/// Off macOS the notification plugin decides, and nothing is shown from here (on Linux, before the app is set up).
#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    #[tokio::test]
    async fn leaves_permission_and_display_to_the_plugin() {
        assert_eq!(super::native_notification_permission(true).await, Ok(None));
        assert_eq!(
            super::native_private_notification("1".into(), "a message".into()).await,
            Ok(false)
        );
        assert_eq!(super::native_clear_notification("1".into()).await, Ok(()));
        assert_eq!(super::native_clear_notifications().await, Ok(()));
    }
}
