use serde::Deserialize;

/// Where the button that asked to share sits in the page, in CSS pixels: the sheet points at it.
#[derive(Debug, Deserialize, Clone, Copy)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A link someone asked to share, handed to the system's share sheet (macOS). Only text, at most
/// 4 KiB, and only from the main window. Resolves to false where there is no sheet to show (Linux,
/// Windows): the page then copies the link instead.
#[tauri::command]
pub fn share_text<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    text: String,
    anchor: Option<Anchor>,
) -> Result<bool, String> {
    if text.is_empty() || text.len() > 4096 || text.chars().any(|c| c.is_control()) {
        return Err("Nothing to share".into());
    }
    #[cfg(target_os = "macos")]
    {
        window
            .with_webview(move |webview| mac::show(webview.inner(), &text, anchor))
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, anchor);
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Anchor;
    use objc2::{rc::Retained, runtime::AnyObject, AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString};

    /// Runs on the main thread (`with_webview`), with the page's WKWebView.
    pub fn show(webview: *mut std::ffi::c_void, text: &str, anchor: Option<Anchor>) {
        let Some(_main) = MainThreadMarker::new() else {
            return;
        };
        if webview.is_null() {
            return;
        }
        // SAFETY: Tauri hands over the WKWebView of this window, an NSView alive while its window is.
        let view: &NSView = unsafe { &*(webview as *const NSView) };
        let bounds = view.bounds();
        let a = anchor.unwrap_or(Anchor {
            x: bounds.size.width / 2.0,
            y: bounds.size.height / 2.0,
            width: 1.0,
            height: 1.0,
        });
        // The page measures from the top; a view that is not flipped measures from the bottom.
        let y = if view.isFlipped() {
            a.y
        } else {
            bounds.size.height - a.y - a.height
        };
        let rect = NSRect::new(
            NSPoint::new(a.x, y),
            NSSize::new(a.width.max(1.0), a.height.max(1.0)),
        );
        let item: Retained<AnyObject> = NSString::from_str(text).into();
        let items = NSArray::from_retained_slice(&[item]);
        // SAFETY: the items are NSStrings, which the picker accepts (NSPasteboardWriting).
        let picker = unsafe {
            NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
        };
        picker.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MinY);
    }
}

/// What reaches the share sheet: text only, bounded, no control characters.
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::WebviewWindowBuilder;

    fn window() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
        let app = mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("app");
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, window)
    }

    #[test]
    fn refuses_empty_oversized_or_control_text_before_any_sheet() {
        let (_app, window) = window();
        for text in [
            String::new(),
            "a".repeat(4097),
            "https://ghostly.tools/g#x\n".into(),
            "tab\there".into(),
            "nul\0".into(),
        ] {
            assert_eq!(
                share_text(window.clone(), text, None).unwrap_err(),
                "Nothing to share"
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_there_is_no_sheet_and_the_page_copies() {
        let (_app, window) = window();
        let longest = "a".repeat(4096);
        assert_eq!(share_text(window, longest, None), Ok(false));
    }
}
