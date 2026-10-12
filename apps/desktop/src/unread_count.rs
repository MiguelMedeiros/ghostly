//! The unread count on the app's launcher icon on Linux. Tauri's window badge (tao) reaches the launcher only through
//! libunity, and only while Unity itself runs, which no current desktop does. The docks that show a count (KDE Plasma's
//! task manager, GNOME's Dash to Dock and Ubuntu Dock, Plank, Latte) read the same Unity launcher API from the session
//! bus instead: a `com.canonical.Unity.LauncherEntry.Update` signal naming the app's desktop entry. So the app sends it
//! from here. macOS's Dock and Windows (no count) keep Tauri's badge, which the page calls there.

/// The app's unread count on its launcher icon; 0 hides it. Linux only: elsewhere the page uses Tauri's badge.
#[tauri::command]
pub async fn native_unread_count(count: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || linux::show(count))
            .await
            .map_err(|_| "No launcher count".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = count;
        Err("No launcher count here".into())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use zbus::blocking::Connection;
    use zbus::zvariant::Value;

    const INTERFACE: &str = "com.canonical.Unity.LauncherEntry";
    /// Any object path will do: the docks match the entry by the `application://` URI, not by the path.
    const PATH: &str = "/com/canonical/unity/launcherentry/ghostly";
    /// The installed app's desktop entry (Ghostly.desktop, as the notifications name it).
    const APP_URI: &str = "application://Ghostly.desktop";

    /// Says `count` on the launcher entry; a count of 0 is hidden.
    pub(super) fn update(connection: &Connection, count: u32) -> zbus::Result<()> {
        let properties = HashMap::from([
            ("count", Value::from(i64::from(count))),
            ("count-visible", Value::from(count > 0)),
        ]);
        connection.emit_signal(
            None::<&str>,
            PATH,
            INTERFACE,
            "Update",
            &(APP_URI, properties),
        )
    }

    /// One connection for as long as the app runs: Dash to Dock drops the count of a sender that leaves the bus.
    static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);

    pub(super) fn show(count: u32) -> Result<(), String> {
        let mut connection = CONNECTION.lock().unwrap();
        if connection.is_none() {
            *connection = Some(Connection::session().map_err(|error| error.to_string())?);
        }
        let sent = update(connection.as_ref().unwrap(), count);
        // A connection that broke is not kept: the next count connects again.
        if sent.is_err() {
            *connection = None;
        }
        sent.map_err(|error| error.to_string())
    }

    #[cfg(test)]
    mod tests {
        // covers: app.attention.badge
        use super::*;
        use std::io::{BufRead, BufReader};
        use std::process::{Child, Command, Stdio};
        use zbus::blocking::MessageIterator;
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

            fn connect(&self) -> Connection {
                zbus::blocking::connection::Builder::address(self.1.as_str())
                    .unwrap()
                    .build()
                    .unwrap()
            }
        }

        impl Drop for Bus {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        /// The issue: on KDE Plasma or GNOME with Dash to Dock, Tauri's badge resolved and the launcher showed no
        /// count, since tao sends nothing unless Unity runs. A dock listening on the bus now hears the count for
        /// Ghostly's desktop entry, and a count of 0 hides it.
        #[test]
        fn a_dock_on_the_session_bus_hears_the_count_for_the_apps_desktop_entry() {
            let bus = Bus::start();
            let dock = bus.connect();
            let rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .interface(INTERFACE)
                .unwrap()
                .member("Update")
                .unwrap()
                .build();
            let mut heard = MessageIterator::for_match_rule(rule, &dock, None).unwrap();
            let app = bus.connect();
            let mut next = || {
                let signal = heard.next().unwrap().unwrap();
                let (uri, properties): (String, HashMap<String, OwnedValue>) =
                    signal.body().deserialize().unwrap();
                let count = i64::try_from(&properties["count"]).unwrap();
                let visible = bool::try_from(&properties["count-visible"]).unwrap();
                (uri, count, visible)
            };

            update(&app, 3).unwrap();
            assert_eq!(next(), ("application://Ghostly.desktop".into(), 3, true));
            update(&app, 0).unwrap();
            assert_eq!(next(), ("application://Ghostly.desktop".into(), 0, false));
        }
    }
}
