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

/// The page starts: the message notifications an earlier one left go, but those posted as `keep`. Android keeps them
/// after the app's process ends; the page kept its chats' tags, and the rest it cannot replace or open. Elsewhere,
/// nothing.
#[tauri::command]
pub async fn native_clear_notifications(keep: Option<Vec<String>>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::android::cancel_notifications(&keep.unwrap_or_default()).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = keep;
        Ok(())
    }
}

/// The page's id of the notification last tapped, taken: the page asks once it listens for `notification-open`, as
/// the tap that started the Android app came before it did. None when there is none, and always off Android.
#[tauri::command]
pub fn native_notification_tap<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("Not allowed from this window".into());
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        Ok(window
            .try_state::<crate::android::NotificationTap>()
            .and_then(|tap| tap.take()))
    }
    #[cfg(not(target_os = "android"))]
    Ok(None)
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
    use std::sync::{mpsc, Arc, LazyLock, Mutex, OnceLock};
    use std::time::Duration;
    use zbus::blocking::{connection, Connection, MessageIterator};
    use zbus::names::OwnedUniqueName;
    use zbus::zvariant::Value;

    const SERVER: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    /// The bus itself, which tells who owns a name.
    const BUS: &str = "org.freedesktop.DBus";
    /// The newest few, as the page keeps (lib/notifications.ts): an older one's click only closes it.
    const KEPT: usize = 64;
    /// A server answers in milliseconds. One that stops answering (frozen, or stopped) is waited for no longer than
    /// this, so it holds neither the thread nor NOTIFIER, and the notifications after it, for good. The call is not
    /// given up: the bus holds it for the server, which shows the notification when it wakes, and its answer still
    /// names the notification there.
    const ANSWER_WITHIN: Duration = Duration::from_secs(5);

    /// A notification of ours: the server that showed it (its unique name on the bus), its id there and ours.
    /// A server that restarts numbers from 1 again, under another unique name.
    type Shown = (Option<OwnedUniqueName>, u32, String);

    /// What is done with a notification of ours once the server answers the call that shows it.
    enum Then {
        Nothing,
        /// The chat's newest message came meanwhile: it takes the place of the one just shown.
        Show(String),
        /// The chat was read meanwhile.
        Close,
    }

    #[derive(Default)]
    struct State {
        /// Our notifications not yet closed, oldest first.
        shown: VecDeque<Shown>,
        /// Ours whose call the server has not answered yet: one at a time for each, so a server that wakes shows
        /// none twice, and each one's number is known.
        sending: HashMap<String, Then>,
    }

    impl State {
        fn shown_as(&mut self, server: Option<OwnedUniqueName>, server_id: u32, id: &str) {
            // A server that is gone closes nothing: what it showed is forgotten at the next one's first.
            // Newest last, and once: the one it replaced is this one now.
            self.shown.retain(|(shown_by, theirs, ours)| {
                *shown_by == server && *theirs != server_id && ours != id
            });
            self.shown.push_back((server, server_id, id.to_string()));
            if self.shown.len() > KEPT {
                self.shown.pop_front();
            }
        }
    }

    /// One connection for every notification, and one thread that hears their clicks.
    pub(super) struct Notifier {
        connection: Connection,
        state: Arc<Mutex<State>>,
    }

    impl Notifier {
        /// `open` hears our id of each notification clicked.
        pub(super) fn new(
            bus: connection::Builder<'static>,
            open: impl Fn(String) + Send + 'static,
        ) -> zbus::Result<Self> {
            let connection = bus.build()?;
            // Subscribed before the first notification is shown, so no click comes before the listener.
            let rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                // Only from the notification server: another process's signal opens nothing.
                .sender(SERVER)?
                .interface(SERVER)?
                .path(PATH)?
                .build();
            let signals = MessageIterator::for_match_rule(rule, &connection, None)?;
            let state: Arc<Mutex<State>> = Arc::default();
            let heard = Arc::clone(&state);
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
                            let shown = &mut heard.lock().unwrap().shown;
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
            Ok(Self { connection, state })
        }

        /// The server's id of our notification `id`, while it is shown, and by the server there is now: the
        /// number a server that is gone gave it is another app's notification by now, or nobody's.
        fn server_id(&self, id: &str) -> Option<u32> {
            let (shown_by, server_id) = {
                let state = self.state.lock().unwrap();
                let (shown_by, server_id, _) =
                    state.shown.iter().find(|(_, _, ours)| ours == id)?;
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
        /// Ok also when the server has not answered within ANSWER_WITHIN: the notification is on its way.
        pub(super) fn show(&self, id: &str, body: &str) -> zbus::Result<()> {
            {
                let mut state = self.state.lock().unwrap();
                if let Some(then) = state.sending.get_mut(id) {
                    *then = Then::Show(body.to_string());
                    return Ok(());
                }
                state.sending.insert(id.to_string(), Then::Nothing);
            }
            let replaces = self.server_id(id).unwrap_or(0);
            let (answered, answer) = mpsc::channel();
            tauri::async_runtime::spawn(send(
                self.connection.inner().clone(),
                Arc::clone(&self.state),
                id.to_string(),
                replaces,
                body.to_string(),
                answered,
            ));
            awaited(answer)
        }

        /// Takes our notification `id` back from the server; nothing when it is gone already.
        pub(super) fn clear(&self, id: &str) -> zbus::Result<()> {
            if let Some(then) = self.state.lock().unwrap().sending.get_mut(id) {
                *then = Then::Close;
                return Ok(());
            }
            let server_id = self.server_id(id);
            self.state
                .lock()
                .unwrap()
                .shown
                .retain(|(_, _, ours)| ours != id);
            let Some(server_id) = server_id else {
                return Ok(());
            };
            let (answered, answer) = mpsc::channel();
            let connection = self.connection.inner().clone();
            tauri::async_runtime::spawn(async move {
                let _ = answered.send(close(&connection, server_id).await);
            });
            awaited(answer)
        }
    }

    /// The first answer to a call, when it comes within ANSWER_WITHIN; Ok when it has not come by then.
    fn awaited(answer: mpsc::Receiver<zbus::Result<()>>) -> zbus::Result<()> {
        match answer.recv_timeout(ANSWER_WITHIN) {
            Ok(answer) => answer,
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(zbus::Error::Failure(
                "Notification delivery unavailable".into(),
            )),
        }
    }

    /// Shows `body` as our notification `id`, then the chat's newest message that came before the server answered,
    /// or closes it when the chat was read meanwhile. `answered` hears the first answer.
    async fn send(
        connection: zbus::Connection,
        state: Arc<Mutex<State>>,
        id: String,
        mut replaces: u32,
        mut body: String,
        answered: mpsc::Sender<zbus::Result<()>>,
    ) {
        let mut answered = Some(answered);
        loop {
            let shown = notify(&connection, replaces, &body).await;
            if let Some(answered) = answered.take() {
                let _ = answered.send(shown.as_ref().map(drop).map_err(Clone::clone));
            }
            let then = {
                let mut state = state.lock().unwrap();
                match &shown {
                    Ok((server, server_id)) => match state.sending.remove(&id) {
                        Some(Then::Close) => {
                            state.shown.retain(|(_, _, ours)| *ours != id);
                            Some(Then::Close)
                        }
                        then => {
                            state.shown_as(server.clone(), *server_id, &id);
                            if let Some(Then::Show(_)) = then {
                                state.sending.insert(id.clone(), Then::Nothing);
                            }
                            then
                        }
                    },
                    Err(_) => {
                        state.sending.remove(&id);
                        None
                    }
                }
            };
            let Ok((_, server_id)) = shown else {
                return;
            };
            match then {
                Some(Then::Show(newest)) => (replaces, body) = (server_id, newest),
                Some(Then::Close) => {
                    let _ = close(&connection, server_id).await;
                    return;
                }
                _ => return,
            }
        }
    }

    /// The server that showed it and its id there.
    async fn notify(
        connection: &zbus::Connection,
        replaces: u32,
        body: &str,
    ) -> zbus::Result<(Option<OwnedUniqueName>, u32)> {
        // The installed app's desktop entry and icon (Ghostly.desktop, ghostly.png); the sound stays the
        // local audio controller's, as on macOS.
        let hints = HashMap::from([
            ("desktop-entry", Value::from("Ghostly")),
            ("suppress-sound", Value::from(true)),
        ]);
        let actions = ["default", "Ghostly"];
        let reply = connection
            .call_method(
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
            )
            .await?;
        let server_id: u32 = reply.body().deserialize()?;
        let server = reply.header().sender().map(|name| name.to_owned().into());
        Ok((server, server_id))
    }

    async fn close(connection: &zbus::Connection, server_id: u32) -> zbus::Result<()> {
        connection
            .call_method(
                Some(SERVER),
                PATH,
                Some(SERVER),
                "CloseNotification",
                &server_id,
            )
            .await
            .map(drop)
    }

    /// Let go (its call gave up, or its connection broke): the connection is closed, so the click listener's
    /// iterator ends and its thread with it. That iterator holds the connection too: dropped alone, it stayed open.
    impl Drop for Notifier {
        fn drop(&mut self) {
            let _ = self.connection.clone().close();
        }
    }

    /// The notifier the app's notifications go through. No call holds it while the server answers: with the server
    /// frozen, each would wait ANSWER_WITHIN in line behind the one before it.
    #[derive(Default)]
    pub(super) struct Notifiers {
        /// Connected at the first notification; tried again at the next one while there is no session bus.
        current: Mutex<Option<Arc<Notifier>>>,
        /// Per id of ours: its calls in turn, so its notifications replace each other as they would one after another.
        turns: Mutex<HashMap<String, Turn>>,
    }

    /// The number of an id's latest call, and the lock its calls take in turn.
    type Turn = (u64, Arc<Mutex<()>>);

    impl Notifiers {
        /// False when it could not be shown from here (no session bus, no notification server).
        pub(super) fn show(
            &self,
            connect: impl FnOnce() -> zbus::Result<Notifier>,
            id: &str,
            body: &str,
        ) -> bool {
            let notifier = {
                let mut current = self.current.lock().unwrap();
                if current.is_none() {
                    *current = connect().ok().map(Arc::new);
                }
                current.clone()
            };
            let Some(notifier) = notifier else {
                return false;
            };
            match self.in_turn(id, || notifier.show(id, body)) {
                // A newer one of the same id is shown in its place. Also on its way to a server that has not
                // answered yet: the plugin's would be a second notification, which the app can neither replace nor
                // close.
                None | Some(Ok(())) => true,
                // The bus answered (no notification server, or it refused): the connection is good.
                Some(Err(zbus::Error::MethodError(..))) => false,
                Some(Err(_)) => {
                    self.let_go(&notifier);
                    false
                }
            }
        }

        /// Nothing before the first notification was shown from here: there is none to take back.
        pub(super) fn clear(&self, id: &str) {
            let Some(notifier) = self.current.lock().unwrap().clone() else {
                return;
            };
            let cleared = self.in_turn(id, || notifier.clear(id));
            // As in `show`: a connection that broke is not kept.
            if matches!(&cleared, Some(Err(error)) if !matches!(error, zbus::Error::MethodError(..)))
            {
                self.let_go(&notifier);
            }
        }

        /// A connection that broke is not kept: its listener ends with it once its last call is done, and the next
        /// notification connects again. One that took its place already stays.
        fn let_go(&self, notifier: &Arc<Notifier>) {
            let mut current = self.current.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|kept| Arc::ptr_eq(kept, notifier))
            {
                *current = None;
            }
        }

        /// Runs `call` once the calls for `id` before it are done; not at all (None) when a later call for `id`
        /// came meanwhile, which takes its place: the newer notification, or the clear of a chat read.
        fn in_turn<T>(&self, id: &str, call: impl FnOnce() -> T) -> Option<T> {
            let (number, turn) = {
                let mut turns = self.turns.lock().unwrap();
                let (latest, turn) = turns.entry(id.to_string()).or_default();
                *latest += 1;
                (*latest, Arc::clone(turn))
            };
            let done = {
                let _turn = turn.lock().unwrap();
                let latest = self.turns.lock().unwrap()[id].0 == number;
                latest.then(call)
            };
            let mut turns = self.turns.lock().unwrap();
            // The last call out takes the id's entry away (the map's and this one's are all that are left).
            if Arc::strong_count(&turn) == 2 {
                turns.remove(id);
            }
            done
        }
    }

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static NOTIFIERS: LazyLock<Notifiers> = LazyLock::new(Notifiers::default);

    pub fn install(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
    }

    /// False when it could not be shown from here (no app yet, no session bus, no notification server).
    pub fn show(id: &str, body: &str) -> bool {
        let Some(app) = APP.get() else {
            return false;
        };
        let connect = || {
            let app = app.clone();
            connection::Builder::session()
                .and_then(|bus| Notifier::new(bus, move |id| super::opened(&app, id)))
        };
        NOTIFIERS.show(connect, id, body)
    }

    pub fn clear(id: &str) {
        NOTIFIERS.clear(id);
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

        /// Stops a server as SIGSTOP does (a hung mako, swaync or gnome-shell): it reads nothing until thawed, and
        /// the bus holds what is sent to it.
        #[derive(Clone, Default)]
        struct Freezer(Arc<(Mutex<bool>, std::sync::Condvar)>);

        impl Freezer {
            fn set(&self, frozen: bool) {
                *self.0 .0.lock().unwrap() = frozen;
                self.0 .1.notify_all();
            }

            /// Blocks the server's only thread while it is frozen.
            fn wait(&self) {
                let (frozen, thawed) = &*self.0;
                drop(thawed.wait_while(frozen.lock().unwrap(), |frozen| *frozen));
            }
        }

        /// A notification server that keeps a list, as GNOME, KDE and swaync do: what it still shows, by its id.
        struct Listing(Arc<Mutex<Vec<(u32, String)>>>, u32, Freezer);

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
                self.2.wait();
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
                self.2.wait();
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
                .serve_at(PATH, Listing(Arc::clone(&listed), 0, Freezer::default()))
                .unwrap()
                .build()
                .unwrap();
            let notifier = Notifier::new(bus.connect(), |_| {}).unwrap();
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
            let notifier = Notifier::new(bus.connect(), move |id| {
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
            let notifier = Notifier::new(bus.connect(), move |id| {
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
                    .serve_at(PATH, Listing(Arc::clone(listed), 0, Freezer::default()))
                    .unwrap()
                    .build()
                    .unwrap()
            };
            let server = serve(&Arc::default());
            let notifier = Notifier::new(bus.connect(), |_| {}).unwrap();
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

        /// Every later message's sound was held back for as long as the server was frozen: the call waited with
        /// no end, holding the thread and NOTIFIER. Now it is waited for no longer than ANSWER_WITHIN, and not as
        /// an error: the notification is on its way, so the plugin sends no second one.
        #[test]
        fn a_frozen_server_holds_the_call_no_longer_than_answer_within() {
            let bus = Bus::start();
            let (_server, _listed, freezer) = frozen_listing(&bus);
            freezer.set(true);
            let notifier = Notifier::new(bus.connect(), |_| {}).unwrap();
            let (done, waited) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = done.send(
                    notifier
                        .show("chat-a", "New message")
                        .map_err(|error| error.to_string()),
                );
            });
            let shown = waited.recv_timeout(ANSWER_WITHIN + Duration::from_secs(5));
            freezer.set(false);
            assert_eq!(
                shown.expect("the call is still waiting for the frozen server"),
                Ok(())
            );
        }

        /// A notification server that stops answering for good: the bus holds our call.
        struct Frozen;

        #[zbus::interface(name = "org.freedesktop.Notifications")]
        impl Frozen {
            #[allow(clippy::too_many_arguments)]
            async fn notify(
                &self,
                _app_name: String,
                _replaces_id: u32,
                _icon: String,
                _summary: String,
                _body: String,
                _actions: Vec<String>,
                _hints: HashMap<String, OwnedValue>,
                _timeout: i32,
            ) -> u32 {
                std::future::pending().await
            }
        }

        /// What a listing server still shows, by its id.
        type Listed = Arc<Mutex<Vec<(u32, String)>>>;

        /// A listing server on a bus of its own, which the test freezes and thaws.
        fn frozen_listing(bus: &Bus) -> (zbus::blocking::Connection, Listed, Freezer) {
            let listed: Listed = Arc::default();
            let freezer = Freezer::default();
            let server = bus
                .connect()
                .name(SERVER)
                .unwrap()
                .serve_at(PATH, Listing(Arc::clone(&listed), 0, freezer.clone()))
                .unwrap()
                .build()
                .unwrap();
            (server, listed, freezer)
        }

        /// What the server lists once it has worked through what the bus held for it.
        fn settled(listed: &Listed, expected: &[(u32, &str)]) {
            let expected: Vec<(u32, String)> = expected
                .iter()
                .map(|(id, body)| (*id, body.to_string()))
                .collect();
            let until = std::time::Instant::now() + Duration::from_secs(10);
            while *listed.lock().unwrap() != expected && std::time::Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(Duration::from_millis(300));
            assert_eq!(*listed.lock().unwrap(), expected);
        }

        /// A server that hung and came back showed every notification the app had given up on as a new one, which
        /// the app could neither replace nor close. Now the late answer is still ours: the chat's newest message
        /// replaces it, sent once, and reading the chat closes it.
        #[test]
        fn a_frozen_server_s_late_answer_is_still_the_chat_s_notification() {
            let bus = Bus::start();
            let (_server, listed, freezer) = frozen_listing(&bus);
            let notifier = Notifier::new(bus.connect(), |_| {}).unwrap();
            notifier.show("chat-b", "another chat").unwrap();
            settled(&listed, &[(1, "another chat")]);

            freezer.set(true);
            // Not given up: the bus holds it for the server, and only its answer tells its number.
            notifier.show("chat-a", "frozen 1").unwrap();
            notifier.show("chat-a", "frozen 2").unwrap();
            notifier.show("chat-a", "frozen 3").unwrap();
            freezer.set(false);
            settled(&listed, &[(1, "another chat"), (2, "frozen 3")]);

            notifier.show("chat-a", "thawed").unwrap();
            settled(&listed, &[(1, "another chat"), (2, "thawed")]);
            notifier.clear("chat-a").unwrap();
            settled(&listed, &[(1, "another chat")]);
        }

        /// The chat was read while the server was frozen: its notification goes when the server comes back, the
        /// one shown before and the one still on its way.
        #[test]
        fn a_chat_read_while_the_server_is_frozen_is_closed_when_it_answers() {
            let bus = Bus::start();
            let (_server, listed, freezer) = frozen_listing(&bus);
            let notifier = Notifier::new(bus.connect(), |_| {}).unwrap();
            notifier.show("chat-a", "before").unwrap();
            notifier.show("chat-b", "another chat").unwrap();
            settled(&listed, &[(1, "before"), (2, "another chat")]);

            freezer.set(true);
            notifier.clear("chat-b").unwrap();
            notifier.show("chat-a", "frozen").unwrap();
            notifier.clear("chat-a").unwrap();
            freezer.set(false);
            settled(&listed, &[]);
        }

        /// Each notification given up on a frozen server left its connection on the bus for good: the click
        /// listener's iterator held it, with a thread and a socket each (11 of them after a 66 s freeze). A notifier
        /// that is let go closes its connection, and its listener ends.
        #[test]
        fn a_notifier_let_go_leaves_the_bus() {
            let bus = Bus::start();
            let _server = bus
                .connect()
                .name(SERVER)
                .unwrap()
                .serve_at(PATH, Frozen)
                .unwrap()
                .build()
                .unwrap();
            let notifier = Notifier::new(bus.connect(), |_| {}).unwrap();
            let name = notifier.connection.unique_name().unwrap().to_string();
            // On its way: the bus holds the call for the frozen server, and the notifier is let go meanwhile.
            assert!(notifier.show("chat-a", "New message").is_ok());
            drop(notifier);

            let other = bus.connect().build().unwrap();
            let on_the_bus = || {
                let reply = other
                    .call_method(
                        Some(BUS),
                        "/org/freedesktop/DBus",
                        Some(BUS),
                        "ListNames",
                        &(),
                    )
                    .unwrap();
                reply
                    .body()
                    .deserialize::<Vec<String>>()
                    .unwrap()
                    .contains(&name)
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while on_the_bus() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "{name} is still on the bus"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        /// Shows `bodies` (our id, text) on `notifiers`, all at once, one thread each; how long until all are done.
        fn all_at_once(bus: &Bus, notifiers: &Notifiers, bodies: &[(&str, &str)]) -> Duration {
            let start = std::sync::Barrier::new(bodies.len());
            let started = std::time::Instant::now();
            std::thread::scope(|scope| {
                for (id, body) in bodies {
                    let start = &start;
                    scope.spawn(move || {
                        start.wait();
                        notifiers.show(|| Notifier::new(bus.connect(), |_| {}), id, body);
                    });
                }
            });
            started.elapsed()
        }

        /// With the server frozen, each notification waited ANSWER_WITHIN in line behind the one before it, holding
        /// NOTIFIER: five in a frozen moment took 25 s. Now the chats' calls wait side by side, and a chat's
        /// notification that a newer one of the same chat replaces is not sent at all.
        #[test]
        fn a_frozen_server_holds_up_no_line() {
            let bus = Bus::start();
            let _server = bus
                .connect()
                .name(SERVER)
                .unwrap()
                .serve_at(PATH, Frozen)
                .unwrap()
                .build()
                .unwrap();
            let took = all_at_once(
                &bus,
                &Notifiers::default(),
                &[
                    ("chat-a", "1"),
                    ("chat-b", "2"),
                    ("chat-a", "3"),
                    ("chat-c", "4"),
                    ("chat-a", "5"),
                ],
            );
            // chat-a's first call, then its newest: two waits at most.
            assert!(
                took < ANSWER_WITHIN * 2 + Duration::from_secs(3),
                "took {took:?}"
            );
        }

        /// What NOTIFIER's line kept: a chat's notifications sent at the same time still leave it one.
        #[test]
        fn a_chat_s_notifications_at_once_leave_it_one() {
            let bus = Bus::start();
            let listed: Arc<Mutex<Vec<(u32, String)>>> = Arc::default();
            let _server = bus
                .connect()
                .name(SERVER)
                .unwrap()
                .serve_at(PATH, Listing(Arc::clone(&listed), 0, Freezer::default()))
                .unwrap()
                .build()
                .unwrap();
            let notifiers = Notifiers::default();
            let bodies: Vec<String> = (0..8).map(|n| format!("burst {n}")).collect();
            let chat_a: Vec<(&str, &str)> = bodies
                .iter()
                .map(|body| ("chat-a", body.as_str()))
                .collect();
            all_at_once(&bus, &notifiers, &chat_a);
            all_at_once(&bus, &notifiers, &[("chat-b", "another chat")]);
            let shown = listed.lock().unwrap().clone();
            assert_eq!(shown.len(), 2, "{shown:?}");
            assert_eq!(shown[1], (2, "another chat".to_string()));

            // And reading the chats takes them both back.
            notifiers.clear("chat-a");
            notifiers.clear("chat-b");
            settled(&listed, &[]);
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
        assert_eq!(
            super::native_clear_notifications(Some(vec!["1".into()])).await,
            Ok(())
        );
    }

    /// Off Android no tap waits for the page, and a contact's web app window may not ask.
    #[test]
    fn no_tap_waits_off_android() {
        use tauri::test::mock_builder;
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let app = mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("app");
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        assert_eq!(super::native_notification_tap(main), Ok(None));
        let url = "ghostly-svc://atlas.peer/".parse().unwrap();
        let other = WebviewWindowBuilder::new(&app, "svc-1", WebviewUrl::CustomProtocol(url))
            .build()
            .unwrap();
        assert_eq!(
            super::native_notification_tap(other),
            Err("Not allowed from this window".into())
        );
    }
}
