//! Calls where the WebView cannot make them: Linux, whose WebKitGTK is built without WebRTC by every major
//! distribution (Ubuntu, Debian, Fedora). The media runs in GStreamer ([`engine`]); the page drives it through
//! these commands and hears back on a channel per camera and per call (`src/desktop/nativeCalls.ts`).
//!
//! Elsewhere (macOS, Windows) the WebView has WebRTC, `native_call_support` says `native: false`, and the other
//! commands refuse: they exist on every platform so the app registers the same commands everywhere.

use serde::Serialize;
#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, InvokeResponseBody};

#[cfg(target_os = "linux")]
pub mod engine;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSupport {
    /// This platform's calls are native (Linux), not the WebView's.
    native: bool,
    /// Why this machine cannot call, when it cannot: what to install.
    missing: Option<String>,
}

#[tauri::command]
pub fn native_call_support() -> CallSupport {
    #[cfg(target_os = "linux")]
    return CallSupport {
        native: true,
        missing: engine::missing(),
    };
    #[cfg(not(target_os = "linux"))]
    CallSupport {
        native: false,
        missing: None,
    }
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct Calls {
    cameras: HashMap<u32, Arc<engine::Camera>>,
    next_camera: u32,
    calls: HashMap<String, Live>,
}

#[cfg(target_os = "linux")]
struct Live {
    events: Channel<InvokeResponseBody>,
    call: Option<Arc<engine::Call>>,
    /// The camera whose picture the call sends, if any.
    camera: Option<u32>,
}

#[cfg(target_os = "linux")]
fn calls() -> &'static Mutex<Calls> {
    static CALLS: OnceLock<Mutex<Calls>> = OnceLock::new();
    CALLS.get_or_init(Mutex::default)
}

#[cfg(not(target_os = "linux"))]
const ELSEWHERE: &str = "Calls here go through the WebView";

/// A failure, in the app's log as well: the page only shows that the call ended.
#[cfg(target_os = "linux")]
fn logged<T>(what: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(error) = &result {
        crate::diagnostics::log(&format!("native call: {what} failed: {error}"));
    }
    result
}

/// Blocking work (opening or stopping a camera) off the IPC thread.
#[cfg(target_os = "linux")]
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn sink(channel: Channel<InvokeResponseBody>) -> impl Fn(Vec<u8>) + Send + Sync + 'static {
    move |bytes| {
        let _ = channel.send(InvokeResponseBody::Raw(bytes));
    }
}

/// Opens the camera; its preview frames (JPEG) arrive on `frames`. Returns its id.
#[tauri::command]
pub async fn native_camera_open(frames: Channel<InvokeResponseBody>) -> Result<u32, String> {
    #[cfg(target_os = "linux")]
    {
        let open = move || engine::Camera::open(engine::fake_media(), Arc::new(sink(frames)));
        let camera = logged("the camera", blocking(open).await)?;
        let mut calls = calls().lock().unwrap();
        calls.next_camera += 1;
        let id = calls.next_camera;
        calls.cameras.insert(id, Arc::new(camera));
        Ok(id)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = sink(frames);
        Err(ELSEWHERE.into())
    }
}

#[tauri::command]
pub async fn native_camera_close(camera: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let closed = {
            let mut calls = calls().lock().unwrap();
            for live in calls.calls.values_mut() {
                if live.camera == Some(camera) {
                    live.camera = None;
                }
            }
            calls.cameras.remove(&camera)
        };
        // Stopping the camera waits for its threads: not on the IPC thread.
        if let Some(closed) = closed {
            closed.attach(None);
            blocking(move || {
                drop(closed);
                Ok(())
            })
            .await?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = camera;
        Ok(())
    }
}

/// A call with this id, its events (JSON: `{"ice": state}`) and the peer's picture (JPEG) on `events`.
#[tauri::command]
pub fn native_call_open(id: String, events: Channel<InvokeResponseBody>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        calls().lock().unwrap().calls.insert(
            id,
            Live {
                events,
                call: None,
                camera: None,
            },
        );
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, sink(events));
        Err(ELSEWHERE.into())
    }
}

/// Starts the call's media with these payload types and this camera, once.
#[cfg(target_os = "linux")]
async fn media(
    id: &str,
    payload_types: (u8, u8),
    camera: Option<u32>,
) -> Result<Arc<engine::Call>, String> {
    let events = {
        let calls = calls().lock().unwrap();
        let live = calls.calls.get(id).ok_or("No such call")?;
        if live.call.is_some() {
            return Err("The call has started already".into());
        }
        live.events.clone()
    };
    let events = Arc::new(sink(events));
    let call = Arc::new(
        engine::Call::new(
            payload_types.0,
            payload_types.1,
            engine::fake_media(),
            events,
        )
        .await?,
    );
    let kept = {
        let mut calls = calls().lock().unwrap();
        let Calls { cameras, calls, .. } = &mut *calls;
        match calls.get_mut(id) {
            Some(live) => {
                live.call = Some(call.clone());
                live.camera = camera;
                if let Some(camera) = camera.and_then(|c| cameras.get(&c)) {
                    camera.attach(Some(call.video_input()));
                }
                true
            }
            None => false,
        }
    };
    if !kept {
        // Hung up while it was starting.
        call.close().await;
        return Err("The call was closed".into());
    }
    Ok(call)
}

#[cfg(target_os = "linux")]
fn call(id: &str) -> Result<Arc<engine::Call>, String> {
    calls()
        .lock()
        .unwrap()
        .calls
        .get(id)
        .and_then(|l| l.call.clone())
        .ok_or_else(|| "No such call".into())
}

/// Our offer, its candidates gathered.
#[tauri::command]
pub async fn native_call_offer(id: String, camera: Option<u32>) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let call = logged(
            "starting",
            media(&id, (engine::OPUS_PT, engine::VP8_PT), camera).await,
        )?;
        logged("the offer", call.offer().await)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, camera);
        Err(ELSEWHERE.into())
    }
}

/// Our answer to the peer's offer, its candidates gathered.
#[tauri::command]
pub async fn native_call_answer(
    id: String,
    offer: String,
    camera: Option<u32>,
) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let call = logged(
            "starting",
            media(&id, engine::offered_payload_types(&offer), camera).await,
        )?;
        logged("the answer", call.answer(&offer).await)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, offer, camera);
        Err(ELSEWHERE.into())
    }
}

/// The peer's answer to our offer.
#[tauri::command]
pub async fn native_call_accept(id: String, answer: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        logged("the peer's answer", call(&id)?.accept(&answer).await)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, answer);
        Err(ELSEWHERE.into())
    }
}

#[tauri::command]
pub fn native_call_mute(id: String, muted: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        call(&id)?.set_muted(muted);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, muted);
        Err(ELSEWHERE.into())
    }
}

/// Sends this camera's picture in the call, or none (`camera` null).
#[tauri::command]
pub fn native_call_camera(id: String, camera: Option<u32>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let mut calls = calls().lock().unwrap();
        let Calls { cameras, calls, .. } = &mut *calls;
        let live = calls.get_mut(&id).ok_or("No such call")?;
        if let Some(previous) = live.camera.and_then(|c| cameras.get(&c)) {
            previous.attach(None);
        }
        live.camera = camera;
        if let (Some(camera), Some(call)) = (camera.and_then(|c| cameras.get(&c)), &live.call) {
            camera.attach(Some(call.video_input()));
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, camera);
        Err(ELSEWHERE.into())
    }
}

/// What went each way so far: frames and audio buffers sent and received, the ICE state, and whether the
/// microphone is muted. Without an id, the call in progress (there is one at a time), or null.
#[tauri::command]
pub fn native_call_stats(id: Option<String>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let call = match id {
            Some(id) => Some(call(&id)?),
            None => calls()
                .lock()
                .unwrap()
                .calls
                .values()
                .find_map(|l| l.call.clone()),
        };
        return match call {
            Some(call) => serde_json::to_value(call.stats()).map_err(|e| e.to_string()),
            None => Ok(serde_json::Value::Null),
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = id;
        Err(ELSEWHERE.into())
    }
}

#[tauri::command]
pub async fn native_call_close(id: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let live = {
            let mut calls = calls().lock().unwrap();
            let live = calls.calls.remove(&id);
            if let Some(camera) = live
                .as_ref()
                .and_then(|l| l.camera)
                .and_then(|c| calls.cameras.get(&c))
            {
                camera.attach(None);
            }
            live
        };
        if let Some(call) = live.and_then(|l| l.call) {
            call.close().await;
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = id;
        Ok(())
    }
}
