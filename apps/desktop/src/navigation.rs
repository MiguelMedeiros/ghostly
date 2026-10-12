//! Where the Ghostly window may go: the app's own pages and nowhere else. Whatever asks it to leave them (a file
//! or a link dropped on it, a link the page did not hand to the system browser) is refused, so the window never
//! shows a page that is not Ghostly under Ghostly's title. A contact's app and an installed app have windows and
//! rules of their own (`viewer`, `app_sandbox`).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};
use url::Url;

/// The name wry serves the app's files under: `tauri://localhost`, and `http(s)://tauri.localhost` where a
/// scheme of our own cannot be registered (Windows, Android).
const APP_SCHEME: &str = "tauri";

/// Whether this build's WebView reaches the app's files over http (`http://tauri.localhost`).
const HTTP_APP_ORIGIN: bool = cfg!(any(windows, target_os = "android"));

/// Whether `url` is one of the app's own pages: the bundled files (in the one spelling this platform has), or
/// the dev server under `tauri dev` (`dev`, None in a built app).
fn is_app_page(url: &Url, http_origin: bool, dev: Option<&Url>) -> bool {
    if dev.is_some_and(|dev| dev.origin().is_tuple() && dev.origin() == url.origin()) {
        return true;
    }
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        APP_SCHEME => {
            !http_origin && host.eq_ignore_ascii_case("localhost") && url.port().is_none()
        }
        "http" | "https" => {
            http_origin
                && host.eq_ignore_ascii_case(&format!("{APP_SCHEME}.localhost"))
                && url.port().is_none()
        }
        _ => false,
    }
}

/// Whether the Ghostly window may go to `url`: one of the app's pages, a blob one of them made (a file saved
/// through a link), or the empty page a WebView starts from. Never a file, a website or any other scheme.
fn may_navigate(url: &Url, http_origin: bool, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "about" => url.path() == "blank",
        "blob" => Url::parse(url.path()).is_ok_and(|inner| is_app_page(&inner, http_origin, dev)),
        _ => is_app_page(url, http_origin, dev),
    }
}

/// The rule, on the Ghostly window (`main`) only: the other windows keep the rules they were opened with.
fn allows<R: Runtime>(webview: &tauri::Webview<R>, url: &Url) -> bool {
    if webview.label() != "main" {
        return true;
    }
    let dev = if tauri::is_dev() {
        webview.config().build.dev_url.clone()
    } else {
        None
    };
    may_navigate(url, HTTP_APP_ORIGIN, dev.as_ref())
}

/// The Ghostly window is made from `tauri.conf.json`, which takes no rule: it comes as a plugin.
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("main-window-navigation")
        .on_navigation(|webview, url| {
            let allowed = allows(webview, url);
            if !allowed {
                // The scheme only: the rest may name a file or a site of the person's.
                crate::diagnostics::log(&format!(
                    "window: a navigation to a {}: address was refused",
                    url.scheme()
                ));
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    // covers: desktop.window
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    /// What a drop or a link could take the window to: none of it loads, on either kind of platform.
    const ELSEWHERE: &[&str] = &[
        "file:///home/ana/Downloads/invoice.html",
        "file:///home/ana/Pictures/picture.svg",
        "file:///home/ana/a%20folder",
        "http://127.0.0.1:5021/landing",
        "http://localhost:5173/",
        "https://example.com/",
        "https://tauri.localhost.example.com/",
        "http://tauri.localhost:8080/",
        "tauri://localhost:8080/",
        "tauri://example.com/",
        "ghostly-app://localhost/",
        "ghostly-file://localhost/1",
        "data:text/html,<h1>Ghostly</h1>",
        "javascript:alert(1)",
        "about:srcdoc",
        "blob:https://example.com/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        "blob:null/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        "blob:file:///1b4e28ba-2fa1-11d2-883f-0016d3cca427",
    ];

    #[test]
    fn the_ghostly_window_goes_to_the_apps_own_pages_only() {
        // macOS and Linux: the app's files under its own scheme.
        for own in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html#/chat/abc",
            "TAURI://LOCALHOST/",
            "about:blank",
            "blob:tauri://localhost/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        ] {
            assert!(may_navigate(&url(own), false, None), "{own}");
        }
        // Windows and Android: the same files over http.
        for own in [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "about:blank",
            "blob:http://tauri.localhost/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        ] {
            assert!(may_navigate(&url(own), true, None), "{own}");
        }
        for other in ELSEWHERE {
            assert!(!may_navigate(&url(other), false, None), "{other}");
            assert!(!may_navigate(&url(other), true, None), "{other}");
        }
        // Each platform has one spelling: the other is a server on this machine, or nothing.
        assert!(!may_navigate(&url("http://tauri.localhost/"), false, None));
        assert!(!may_navigate(
            &url("blob:http://tauri.localhost/1b4e28ba-2fa1-11d2-883f-0016d3cca427"),
            false,
            None
        ));
        assert!(!may_navigate(&url("tauri://localhost/"), true, None));
    }

    #[test]
    fn under_tauri_dev_the_dev_server_is_the_app_too() {
        let dev = url("http://localhost:5173");
        for own in [
            "http://localhost:5173/",
            "http://localhost:5173/src/main.tsx",
            "blob:http://localhost:5173/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
            "tauri://localhost/",
        ] {
            assert!(may_navigate(&url(own), false, Some(&dev)), "{own}");
        }
        for other in [
            "http://localhost:5174/",
            "https://localhost:5173/",
            "http://127.0.0.1:5173/",
            "http://localhost.example.com:5173/",
            "file:///home/ana/Downloads/invoice.html",
            "https://example.com/",
        ] {
            assert!(!may_navigate(&url(other), false, Some(&dev)), "{other}");
        }
        // A dev address with no origin of its own names no page.
        let odd = url("file:///srv/ui/index.html");
        assert!(!may_navigate(
            &url("file:///home/ana/Downloads/invoice.html"),
            false,
            Some(&odd)
        ));
    }

    /// The rule as the app carries it: on the Ghostly window, and on no window of a contact's or an installed app.
    #[test]
    fn the_rule_is_the_ghostly_windows_and_the_app_installs_it() {
        let app = mock_builder()
            .plugin(guard())
            .build(mock_context(noop_assets()))
            .expect("app");
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let own = if HTTP_APP_ORIGIN {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };
        assert!(allows(main.as_ref(), &url(own)));
        for other in ELSEWHERE {
            assert!(!allows(main.as_ref(), &url(other)), "{other}");
        }
        // A test build is no `tauri dev`: the dev server's address is one more website.
        if !tauri::is_dev() {
            assert!(!allows(main.as_ref(), &url("http://localhost:5173/")));
        }
        let address = url("ghostly-app://localhost/");
        let other = WebviewWindowBuilder::new(&app, "svc-1", WebviewUrl::CustomProtocol(address))
            .build()
            .unwrap();
        assert!(allows(other.as_ref(), &url("ghostly-app://localhost/")));
        assert!(allows(other.as_ref(), &url("about:srcdoc")));
        // `run` is what a person's app is built from.
        let run = include_str!("lib.rs");
        let run = &run[run.find("pub fn run()").unwrap()..];
        let run = &run[..run.find("\n}\n").unwrap()];
        assert!(run.contains(".plugin(navigation::guard())"));
    }
}
