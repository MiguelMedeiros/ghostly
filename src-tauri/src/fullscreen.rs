//! A video's Full screen button (the Fullscreen API) in the Ghostly window, on every engine.
//!
//! - macOS: WKWebView ships with element full screen off, so the button did nothing (Picture in Picture worked).
//!   `WKPreferences.elementFullscreenEnabled` (public since macOS 12.3) turns it on; WebKit then shows the element
//!   in a full-screen window of its own. Older macOS only has the private `fullScreenEnabled` key, what wry sets
//!   under Tauri's `macos-private-api`.
//! - Windows: WebView2 has the API, but a full-screen element only fills the webview. The host puts the window in
//!   full screen when WebView2 says it holds one (`ContainsFullScreenElementChanged`), and back out after.
//! - Linux: WebKitGTK has it on (`enable-fullscreen`) and puts its own window in full screen.

/// Turns the Fullscreen API on for this window's webview, where the engine needs it.
pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    let _ = window.with_webview(|webview| unsafe { macos::enable(webview.inner()) });
    #[cfg(windows)]
    {
        let target = window.clone();
        let _ = window.with_webview(move |webview| windows::follow(webview.controller(), target));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSNumber, NSString};

    /// `webview` is the window's `WKWebView`. Its configuration is a copy, but one that shares the live preferences.
    pub unsafe fn enable(webview: *mut std::ffi::c_void) {
        let Some(webview) = (webview as *mut AnyObject).as_ref() else {
            return;
        };
        let configuration: Option<Retained<AnyObject>> = msg_send![webview, configuration];
        let Some(configuration) = configuration else {
            return;
        };
        let preferences: Option<Retained<AnyObject>> = msg_send![&*configuration, preferences];
        let Some(preferences) = preferences else {
            return;
        };
        let public: Bool =
            msg_send![&*preferences, respondsToSelector: sel!(setElementFullscreenEnabled:)];
        if public.as_bool() {
            let _: () = msg_send![&*preferences, setElementFullscreenEnabled: Bool::YES];
        } else {
            let yes = NSNumber::new_bool(true);
            let key = NSString::from_str("fullScreenEnabled");
            let _: () = msg_send![&*preferences, setValue: &*yes, forKey: &*key];
        }
    }
}

#[cfg(windows)]
mod windows {
    use webview2_com::ContainsFullScreenElementChangedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;

    /// The window follows the webview in and out of full screen.
    pub fn follow<R: tauri::Runtime>(
        controller: ICoreWebView2Controller,
        window: tauri::WebviewWindow<R>,
    ) {
        unsafe {
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let handler =
                ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(sender) = sender {
                        let mut contains = windows_core::BOOL::default();
                        sender.ContainsFullScreenElement(&mut contains)?;
                        let _ = window.set_fullscreen(contains.as_bool());
                    }
                    Ok(())
                }));
            let mut token = 0i64;
            let _ = core.add_ContainsFullScreenElementChanged(&handler, &mut token);
        }
    }
}
