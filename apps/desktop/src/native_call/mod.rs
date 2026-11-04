//! Calls where the WebView cannot make them: Linux, whose WebKitGTK is built without WebRTC by every major
//! distribution (Ubuntu, Debian, Fedora). The media runs in GStreamer ([`engine`]); the page drives it through
//! these commands and hears back on a channel per camera and per call (`apps/ui/src/desktop/nativeCalls.ts`).
//!
//! Which microphone, camera and speaker is the page's choice, passed here by name ([`devices`]): the list the
//! page shows is this one (`native_call_devices`), and a call switches them live.
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
pub mod devices;
#[cfg(target_os = "linux")]
pub mod engine;
#[cfg(any(target_os = "linux", test))]
pub mod gather;
pub mod ice;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSupport {
    /// This platform's calls are native (Linux), not the WebView's.
    native: bool,
    /// Why this machine cannot call, when it cannot: what to install.
    missing: Option<String>,
}

/// Whether calls are native here, and if this machine lacks something for them. Async: the first check on a
/// machine builds GStreamer's plugin registry (a fraction of a second), which must not hold the UI thread.
#[tauri::command]
pub async fn native_call_support() -> CallSupport {
    #[cfg(target_os = "linux")]
    return CallSupport {
        native: true,
        missing: tauri::async_runtime::spawn_blocking(engine::missing)
            .await
            .unwrap_or_else(|e| Some(e.to_string())),
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
    /// Microphones open for Settings' meter.
    meters: HashMap<u32, engine::Meter>,
    next_meter: u32,
    calls: HashMap<String, Live>,
    /// Which page of the Ghostly window this is, counted from the app's start (`page_started`).
    page: u64,
}

#[cfg(target_os = "linux")]
struct Live {
    events: Channel<InvokeResponseBody>,
    call: Option<Arc<engine::Call>>,
    /// The camera whose picture the call sends, if any.
    camera: Option<u32>,
    /// The profile's own ICE servers (a TURN server, typically), the usable ones.
    ice: Vec<ice::IceServer>,
    /// Hide my IP from contacts: the call keeps to their TURN servers.
    relay_only: bool,
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

/// Held by a test (`write`) while it lets a page go: a camera or a meter opening meanwhile waits here, still
/// opening, however soon its device would have opened.
#[cfg(all(test, target_os = "linux"))]
static OPENS_HELD: std::sync::RwLock<()> = std::sync::RwLock::new(());

/// Where a camera's or a meter's open starts: in tests, it waits while a test holds opens (`OPENS_HELD`).
#[cfg(target_os = "linux")]
fn opening() {
    #[cfg(test)]
    drop(OPENS_HELD.read().unwrap_or_else(|e| e.into_inner()));
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

/// The microphones, cameras and speakers there are, as `[{ kind, label }]` (`kind` as `MediaDeviceInfo` says
/// it). The label is how the other commands name a device.
#[tauri::command]
pub async fn native_call_devices() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let list = blocking(|| Ok(devices::list(engine::fake_media()))).await?;
        serde_json::to_value(list).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(ELSEWHERE.into())
    }
}

/// Tells `events` each time a microphone, camera or speaker comes or goes.
#[tauri::command]
pub fn native_call_devices_watch(events: Channel<InvokeResponseBody>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        devices::watch(Arc::new(sink(events)));
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = sink(events);
        Err(ELSEWHERE.into())
    }
}

/// A camera open: its id, and the name of the one it is (null: the default one).
#[derive(Serialize)]
pub struct OpenCamera {
    camera: u32,
    device: Option<String>,
}

/// Opens the camera named `device`, or the default one when there is none by that name (or `device` is null);
/// its preview frames (JPEG) arrive on `frames`, and `{"ended":"camera"}` if it stops (unplugged, failing).
#[tauri::command]
pub async fn native_camera_open(
    frames: Channel<InvokeResponseBody>,
    device: Option<String>,
) -> Result<OpenCamera, String> {
    #[cfg(target_os = "linux")]
    {
        let page = calls().lock().unwrap().page;
        let open = move || {
            opening();
            engine::Camera::open(
                engine::fake_media(),
                device.as_deref(),
                Arc::new(sink(frames)),
            )
        };
        let camera = logged("the camera", blocking(open).await)?;
        let device = camera.device.clone();
        let kept = {
            let mut calls = calls().lock().unwrap();
            if calls.page == page {
                calls.next_camera += 1;
                let id = calls.next_camera;
                calls.cameras.insert(id, Arc::new(camera));
                Ok(id)
            } else {
                Err(camera)
            }
        };
        match kept {
            Ok(id) => Ok(OpenCamera { camera: id, device }),
            // The page that asked is gone (another one started while the camera was opening): nobody holds its id.
            Err(camera) => {
                blocking(move || {
                    drop(camera);
                    Ok(())
                })
                .await?;
                Err("The page that asked for this camera is gone".into())
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (sink(frames), device);
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

/// A microphone open for its meter: its id, and the name of the one it is (null: the default one).
#[derive(Serialize)]
pub struct OpenMeter {
    meter: u32,
    device: Option<String>,
}

/// Opens the microphone named `device` (or the default one) for Settings' meter; its loudness, 0 to 1, arrives
/// on `levels` as JSON (`{"level":0.4}`) until `native_microphone_meter_close`.
#[tauri::command]
pub async fn native_microphone_meter(
    levels: Channel<InvokeResponseBody>,
    device: Option<String>,
) -> Result<OpenMeter, String> {
    #[cfg(target_os = "linux")]
    {
        let page = calls().lock().unwrap().page;
        let open = move || {
            opening();
            engine::Meter::open(
                engine::fake_media(),
                device.as_deref(),
                Arc::new(sink(levels)),
            )
        };
        let meter = logged("the microphone's meter", blocking(open).await)?;
        let device = meter.device.clone();
        let kept = {
            let mut calls = calls().lock().unwrap();
            if calls.page == page {
                calls.next_meter += 1;
                let id = calls.next_meter;
                calls.meters.insert(id, meter);
                Ok(id)
            } else {
                Err(meter)
            }
        };
        match kept {
            Ok(id) => Ok(OpenMeter { meter: id, device }),
            // As for a camera: the page that asked is gone.
            Err(meter) => {
                blocking(move || {
                    drop(meter);
                    Ok(())
                })
                .await?;
                Err("The page that asked for this microphone is gone".into())
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (sink(levels), device);
        Err(ELSEWHERE.into())
    }
}

#[tauri::command]
pub async fn native_microphone_meter_close(meter: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let closed = calls().lock().unwrap().meters.remove(&meter);
        if let Some(closed) = closed {
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
        let _ = meter;
        Ok(())
    }
}

/// Plays a short tone on the speaker named `device` (or the default one), and returns once it has played, with
/// the name of the speaker it played on (null: the default).
#[tauri::command]
pub async fn native_speaker_test(device: Option<String>) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        logged(
            "the speakers' test",
            blocking(move || engine::test_speaker(engine::fake_media(), device.as_deref())).await,
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = device;
        Err(ELSEWHERE.into())
    }
}

/// A call with this id, its events (JSON: `{"ice": state}`, `{"ended":"microphone"}`) and the peer's picture
/// (JPEG) on `events`.
/// `ice_servers`: the profile's own ICE servers (Settings, Network), used after the built-in STUN server; one
/// that is not usable is left out ([`ice::usable`]). `relay_only`: Hide my IP from contacts, the call uses their
/// TURN servers alone and gathers relay candidates only (WISP 601, Relay only).
#[tauri::command]
pub fn native_call_open(
    id: String,
    events: Channel<InvokeResponseBody>,
    ice_servers: Option<Vec<ice::IceServer>>,
    relay_only: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let ice = ice::usable(&ice_servers.unwrap_or_default());
        calls().lock().unwrap().calls.insert(
            id,
            Live {
                events,
                call: None,
                camera: None,
                ice,
                relay_only: relay_only.unwrap_or(false),
            },
        );
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, sink(events), ice_servers, relay_only);
        Err(ELSEWHERE.into())
    }
}

/// A description for the page, and the microphone the call sends (null: the default).
#[derive(Serialize)]
pub struct Described {
    sdp: String,
    microphone: Option<String>,
}

#[cfg(target_os = "linux")]
fn described(call: &engine::Call, sdp: String) -> Described {
    Described {
        sdp,
        microphone: call.stats().microphone,
    }
}

/// Starts the call's media with these payload types, this camera and these devices, once.
#[cfg(target_os = "linux")]
async fn media(
    id: &str,
    payload_types: (u8, u8),
    camera: Option<u32>,
    devices: engine::Devices,
) -> Result<Arc<engine::Call>, String> {
    let (events, ice, relay_only) = {
        let calls = calls().lock().unwrap();
        let live = calls.calls.get(id).ok_or("No such call")?;
        if live.call.is_some() {
            return Err("The call has started already".into());
        }
        (live.events.clone(), live.ice.clone(), live.relay_only)
    };
    let events = Arc::new(sink(events));
    let call = Arc::new(
        engine::Call::new(
            payload_types.0,
            payload_types.1,
            engine::fake_media(),
            devices,
            &ice,
            relay_only,
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

/// Our offer, its candidates gathered. `microphone` and `speaker`: the devices by name (null: the default).
/// `restart`: the call has started, and this offer restarts ICE on its connection (WISP 601, "Reconnecting");
/// its media and devices stay as they are.
#[tauri::command]
pub async fn native_call_offer(
    id: String,
    camera: Option<u32>,
    microphone: Option<String>,
    speaker: Option<String>,
    restart: Option<bool>,
) -> Result<Described, String> {
    #[cfg(target_os = "linux")]
    {
        if restart == Some(true) {
            let call = call(&id)?;
            let sdp = logged("the restart offer", call.offer(true).await)?;
            return Ok(described(&call, sdp));
        }
        let devices = engine::Devices {
            microphone,
            speaker,
        };
        let call = logged(
            "starting",
            media(&id, (engine::OPUS_PT, engine::VP8_PT), camera, devices).await,
        )?;
        let sdp = logged("the offer", call.offer(false).await)?;
        Ok(described(&call, sdp))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, camera, microphone, speaker, restart);
        Err(ELSEWHERE.into())
    }
}

/// Our answer to the peer's offer, its candidates gathered. The devices as for the offer. `restart`: the call
/// has started, and the offer is the peer's ICE restart: answered on the call's connection.
#[tauri::command]
pub async fn native_call_answer(
    id: String,
    offer: String,
    camera: Option<u32>,
    microphone: Option<String>,
    speaker: Option<String>,
    restart: Option<bool>,
) -> Result<Described, String> {
    #[cfg(target_os = "linux")]
    {
        if restart == Some(true) {
            let call = call(&id)?;
            let sdp = logged("the restart answer", call.answer(&offer, true).await)?;
            return Ok(described(&call, sdp));
        }
        let devices = engine::Devices {
            microphone,
            speaker,
        };
        let call = logged(
            "starting",
            media(&id, engine::offered_payload_types(&offer), camera, devices).await,
        )?;
        let sdp = logged("the answer", call.answer(&offer, false).await)?;
        Ok(described(&call, sdp))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, offer, camera, microphone, speaker, restart);
        Err(ELSEWHERE.into())
    }
}

/// Sends the microphone named `device` in place of the one on (null: the default); the default too when there
/// is none by that name. Returns the name of the one sent now (null: the default).
#[tauri::command]
pub async fn native_call_microphone(
    id: String,
    device: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let call = call(&id)?;
        logged(
            "switching the microphone",
            blocking(move || call.set_microphone(device.as_deref())).await,
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, device);
        Err(ELSEWHERE.into())
    }
}

/// Plays the call on the speaker named `device` (null: the default), from now on.
#[tauri::command]
pub async fn native_call_speaker(id: String, device: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let call = call(&id)?;
        logged(
            "switching the speaker",
            blocking(move || call.set_speaker(device)).await,
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, device);
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

/// The page draws who is speaking, or no longer does: the call says each side's level only while it does
/// ([`engine::Call::set_levels`]).
#[tauri::command]
pub fn native_call_levels(id: String, on: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        call(&id)?.set_levels(on);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (id, on);
        Err(ELSEWHERE.into())
    }
}

/// The page is in sight, or out of it (`document.hidden`): out of sight, the cameras' previews and the call's
/// pictures are not made JPEGs for it past the first ([`engine::PAGE_HIDDEN`]).
#[tauri::command]
pub fn native_pictures_shown(shown: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        engine::PAGE_HIDDEN.store(!shown, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = shown;
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

/// What went each way so far: frames and audio buffers sent and received, the ICE state, whether the
/// microphone is muted, and the microphone, speaker and camera in use by name (null: the default, or none);
/// `rtp`, what the connection counted (`engine::Call::transport`). Without an id, the call in progress (there is one at a time), or null.
#[tauri::command]
pub async fn native_call_stats(id: Option<String>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let (call, camera) = {
            let calls = calls().lock().unwrap();
            let live = match &id {
                Some(id) => calls.calls.get(id).filter(|l| l.call.is_some()),
                None => calls.calls.values().find(|l| l.call.is_some()),
            };
            if id.is_some() && live.is_none() {
                return Err("No such call".into());
            }
            let camera = live
                .and_then(|l| l.camera)
                .and_then(|c| calls.cameras.get(&c))
                .and_then(|c| c.device.clone());
            (live.and_then(|l| l.call.clone()), camera)
        };
        match call {
            Some(call) => {
                let mut stats = serde_json::to_value(call.stats()).map_err(|e| e.to_string())?;
                stats["camera"] = camera.into();
                stats["rtp"] = call.transport().await;
                Ok(stats)
            }
            None => Ok(serde_json::Value::Null),
        }
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

/// A document takes the Ghostly window's place (`page_started` in `lib.rs`): the page before it held its cameras,
/// meters and calls here by ids only it knew, and nothing would close them. They close as `native_call_close`,
/// `native_camera_close` and `native_microphone_meter_close` close them, and its device watch stops being told.
/// The ids go on counting: an id the page before had is never the next one's. A camera or meter still opening for
/// the page before is closed as it opens (`page`). The new page is taken as in sight until it says otherwise.
pub fn page_started() {
    #[cfg(target_os = "linux")]
    {
        devices::page_started();
        engine::PAGE_HIDDEN.store(false, std::sync::atomic::Ordering::Relaxed);
        let (cameras, meters, live) = {
            let mut calls = calls().lock().unwrap();
            calls.page += 1;
            (
                std::mem::take(&mut calls.cameras),
                std::mem::take(&mut calls.meters),
                std::mem::take(&mut calls.calls),
            )
        };
        if cameras.is_empty() && meters.is_empty() && live.is_empty() {
            return;
        }
        for camera in cameras.values() {
            camera.attach(None);
        }
        // Stopping a pipeline waits for its threads: not on the thread loading the page.
        tauri::async_runtime::spawn(async move {
            for call in live.into_values().filter_map(|l| l.call) {
                call.close().await;
            }
            let _ = blocking(move || {
                drop((cameras, meters));
                Ok(())
            })
            .await;
        });
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    // covers: calls.linux-native
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    fn counting(count: &Arc<AtomicU64>) -> engine::Sink {
        let count = count.clone();
        Arc::new(move |_| {
            count.fetch_add(1, Ordering::Relaxed);
        })
    }

    fn until(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The tests share `calls()`: one at a time.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: Mutex<()> = Mutex::new(());
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Nothing more comes on this count for half a second.
    fn quiet(count: &Arc<AtomicU64>) -> bool {
        let before = count.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(500));
        count.load(Ordering::Relaxed) == before
    }

    /// The page goes while Settings' camera preview and meter are still opening (a camera takes a second or so):
    /// they close as they open, and the next page finds neither, rather than a camera and a microphone left on
    /// under ids nobody holds until the app quits.
    #[test]
    fn a_camera_and_a_meter_still_opening_as_the_page_goes_are_closed() {
        use std::future::Future;
        use std::task::{Context, Waker};
        if let Some(missing) = engine::missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let _serial = serial();
        std::env::set_var("GHOSTLY_FAKE_MEDIA", "1");
        let (frames, levels) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let channel = |count: &Arc<AtomicU64>| {
            let count = count.clone();
            Channel::new(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
                Ok(())
            })
        };
        let mut camera = Box::pin(native_camera_open(channel(&frames), None));
        let mut meter = Box::pin(native_microphone_meter(channel(&levels), None));
        // Each asked, and opening until the page has gone: the test tone opens in moments, and on a busy machine it
        // was open before its first poll, kept by the page that was still there (CI, 2026-11-05).
        let held = OPENS_HELD.write().unwrap_or_else(|e| e.into_inner());
        let mut cx = Context::from_waker(Waker::noop());
        assert!(camera.as_mut().poll(&mut cx).is_pending());
        assert!(meter.as_mut().poll(&mut cx).is_pending());

        page_started();
        drop(held);

        let camera = tauri::async_runtime::block_on(camera);
        let meter = tauri::async_runtime::block_on(meter);
        assert!(camera.is_err(), "the camera went to a page that is gone");
        assert!(meter.is_err(), "the meter went to a page that is gone");
        {
            let calls = calls().lock().unwrap();
            assert!(calls.cameras.is_empty(), "a camera stayed open");
            assert!(calls.meters.is_empty(), "a meter stayed open");
        }
        until("the camera kept running", || quiet(&frames));
        until("the microphone kept running", || quiet(&levels));
    }

    /// The page goes with a camera's preview, Settings' meter and a call open: the next one finds none of them,
    /// and the camera and the microphone stop. Skipped where the GStreamer plugins are missing.
    #[test]
    fn a_new_page_closes_the_cameras_meters_and_calls_of_the_one_before() {
        if let Some(missing) = engine::missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let _serial = serial();
        let (frames, levels) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let camera = engine::Camera::open(true, None, counting(&frames)).unwrap();
        let meter = engine::Meter::open(true, None, counting(&levels)).unwrap();
        {
            let mut calls = calls().lock().unwrap();
            calls.cameras.insert(1, Arc::new(camera));
            calls.meters.insert(1, meter);
            calls.calls.insert(
                "call".into(),
                Live {
                    events: Channel::new(|_| Ok(())),
                    call: None,
                    camera: Some(1),
                    ice: Vec::new(),
                    relay_only: false,
                },
            );
        }
        until("no frames", || frames.load(Ordering::Relaxed) > 0);
        until("no levels", || levels.load(Ordering::Relaxed) > 0);

        page_started();

        {
            let calls = calls().lock().unwrap();
            assert!(calls.cameras.is_empty(), "a camera stayed open");
            assert!(calls.meters.is_empty(), "a meter stayed open");
            assert!(calls.calls.is_empty(), "a call stayed open");
        }
        // Stopped, not just forgotten: nothing more comes from either.
        until("the camera kept running", || quiet(&frames));
        until("the microphone kept running", || quiet(&levels));
    }
}
