//! Call media on Linux, where WebKitGTK has no WebRTC. Two parts:
//!
//! - WebRTC itself (ICE, DTLS-SRTP, RTP and RTCP) is `webrtc-rs`, in Rust, so a Linux Desktop calls a Chrome,
//!   Safari or WKWebView peer directly over the same `calls/1` signals (WISP 601).
//! - The media is GStreamer: the microphone to Opus and the camera to VP8 on the way out; on the way in, the
//!   peer's RTP through a jitter buffer to the speakers and to JPEG frames for the page. Only elements from
//!   gst-plugins-base and -good, which WebKitGTK itself depends on.
//!
//! Not GStreamer's own `webrtcbin`: it needs libnice, which on Ubuntu 22.04 and Debian 12 links libsoup 2
//! (through gupnp-igd), and loading libsoup 2 into a WebKitGTK 4.1 process (libsoup 3) aborts it.
//!
//! The page drives this through `apps/ui/src/desktop/nativeCalls.ts`, which looks like an `RTCPeerConnection` to the
//! call hook. Which microphone, camera and speaker: [`devices`](super::devices), by name.

use super::devices::{self, Kind, FAKE_CAMERAS};
use super::gather::{self, Gathering};
use super::ice::{self, IceServer};
use bytes::Bytes;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use rtc::media::Sample;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_OPUS, MIME_TYPE_VP8};
use rtc::peer_connection::configuration::{RTCIceTransportPolicy, RTCOfferOptions};
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::rtp_sender::{
    RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters,
    RTCRtpEncodingParameters, RtpCodecKind,
};
use rtc::shared::marshal::Marshal;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::media_stream::MediaStreamTrack;
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceConnectionState,
    RTCIceGatheringState, RTCIceServer, RTCPeerConnectionIceEvent, RTCSessionDescription,
    RTCStatsReportEntry, Registry, SettingEngineBuilder, StatsSelector,
};

/// The payload types the rebuilt SDP assumes (callSignal.ts), used unless an offer says otherwise.
pub const OPUS_PT: u8 = 111;
pub const VP8_PT: u8 = 96;
/// The camera's picture: this wide, its own shape, this often.
const WIDTH: u32 = 640;
const FPS: u32 = 15;
/// What the page gets to show, at most: the size and rate of the JPEGs.
const SHOWN_MAX: u32 = 960;
const SHOWN_FPS: u32 = 15;
/// The most pixels a peer's picture is decoded at: 8K UHD, more than any screen a browser shares. VP8 allows
/// 16383×16383, 268 million: each such picture cost a third of a second of a core and the app 2.4 GiB, for a
/// picture shown at most SHOWN_MAX wide ([`refuse_large`]).
const DECODED_MOST: u64 = 7680 * 4320;
/// How long before it is due a picture is shown all the same ([`due`]).
const SHOWN_EARLY: Duration = Duration::from_millis(8);
/// The browsers' own STUN server (RTC_CONFIG), for the server reflexive candidate.
const STUN: &str = "stun:stun.l.google.com:19302";
/// How long its name may take to resolve before webrtc-rs is left to resolve it ([`gather::stun_urls`]).
const STUN_LOOKUP: Duration = Duration::from_secs(5);
/// How often to ask for a keyframe while no picture has been decoded yet.
const KEYFRAME_UNTIL_PICTURE: Duration = Duration::from_secs(1);

/// The Ghostly window's page is out of sight (`native_pictures_shown`). The page draws no picture then
/// (`Picture.show`), so each picture goes to it until one has gone, and the ones after are left out before they
/// are scaled or made a JPEG: a video call's two took 6% of a core here, and 1 MB a second through Tauri's channel,
/// for nobody. Back in sight, the next one goes. A call's levels wait for it too ([`Shared::hears`]).
pub static PAGE_HIDDEN: AtomicBool = AtomicBool::new(false);

/// A JPEG frame for the page, or an event: whatever the page is told.
pub type Sink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// The test tone that stands for the microphone ([`fake_media`]).
const TONE: &str = "audiotestsrc is-live=true wave=sine freq=440 volume=0.2";

/// Test pictures and a test tone in place of the camera and the microphone: the end-to-end tests set
/// `GHOSTLY_FAKE_MEDIA`, like Chromium's fake devices. Debug builds only.
pub fn fake_media() -> bool {
    cfg!(debug_assertions) && std::env::var_os("GHOSTLY_FAKE_MEDIA").is_some()
}

/// What calls need, and the Debian and Ubuntu package that brings it (WebKitGTK depends on both).
const NEEDED: &[(&str, &str)] = &[
    ("rtpjitterbuffer", "gstreamer1.0-plugins-good"),
    ("rtpopusdepay", "gstreamer1.0-plugins-good"),
    ("rtpvp8depay", "gstreamer1.0-plugins-good"),
    ("vp8enc", "gstreamer1.0-plugins-good"),
    ("vp8dec", "gstreamer1.0-plugins-good"),
    ("jpegenc", "gstreamer1.0-plugins-good"),
    ("autoaudiosrc", "gstreamer1.0-plugins-good"),
    ("autoaudiosink", "gstreamer1.0-plugins-good"),
    ("level", "gstreamer1.0-plugins-good"),
    ("opusenc", "gstreamer1.0-plugins-base"),
    ("opusdec", "gstreamer1.0-plugins-base"),
    ("volume", "gstreamer1.0-plugins-base"),
    ("videoconvert", "gstreamer1.0-plugins-base"),
    ("videoscale", "gstreamer1.0-plugins-base"),
    ("videorate", "gstreamer1.0-plugins-base"),
    ("audioconvert", "gstreamer1.0-plugins-base"),
    ("audioresample", "gstreamer1.0-plugins-base"),
    ("appsrc", "gstreamer1.0-plugins-base"),
    ("appsink", "gstreamer1.0-plugins-base"),
];

/// Why this machine cannot call, and what to install; None when it can.
pub fn missing() -> Option<String> {
    if let Err(error) = gst::init() {
        return Some(format!(
            "Calls need GStreamer, which did not start: {error}"
        ));
    }
    let packages: BTreeSet<&str> = NEEDED
        .iter()
        .filter(|(element, _)| gst::ElementFactory::find(element).is_none())
        .map(|(_, package)| *package)
        .collect();
    if packages.is_empty() {
        return None;
    }
    let list: Vec<&str> = packages.into_iter().collect();
    Some(format!(
        "Calls need GStreamer plugins: install {}",
        list.join(", ")
    ))
}

/// Why a pipeline would not start, from its bus if it said.
fn start(pipeline: &gst::Pipeline, what: &str) -> Result<(), String> {
    if pipeline.set_state(gst::State::Playing).is_ok() {
        return Ok(());
    }
    let said = pipeline.bus().and_then(|bus| {
        bus.iter_filtered(&[gst::MessageType::Error])
            .find_map(|message| match message.view() {
                gst::MessageView::Error(error) => Some(error.error().to_string()),
                _ => None,
            })
    });
    let _ = pipeline.set_state(gst::State::Null);
    Err(match said {
        Some(error) => format!("{what}: {error}"),
        None => format!("{what} could not start"),
    })
}

/// How long a device just started has to give its first buffer before it counts as working all the same.
const FIRST_BUFFER: Duration = Duration::from_secs(2);

/// [`start`] for a device that captures: it has started once its first buffer reaches a sink. GStreamer says yes
/// to `set_state` and only then opens a live source and agrees on a format, so a camera that cannot ("not-
/// negotiated") or a device that fails right away says so on the bus a moment later: that start failed too. One
/// that has given nothing by FIRST_BUFFER and said nothing is taken as started.
fn start_capturing(pipeline: &gst::Pipeline, what: &str) -> Result<(), String> {
    let bus = pipeline.bus().ok_or("No bus")?;
    let flowing = || gst::message::Application::new(gst::Structure::new_empty("ghostly-flowing"));
    let mut sinks = pipeline.iterate_sinks();
    while let Ok(Some(sink)) = sinks.next() {
        let Some(pad) = sink.static_pad("sink") else {
            continue;
        };
        let to = sink.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            let _ = to.post_message(flowing());
            gst::PadProbeReturn::Remove
        });
    }
    start(pipeline, what)?;
    let deadline = Instant::now() + FIRST_BUFFER;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let Some(message) = bus.timed_pop_filtered(
            gst::ClockTime::from_nseconds(left.as_nanos() as u64),
            &[gst::MessageType::Error, gst::MessageType::Application],
        ) else {
            return Ok(());
        };
        match message.view() {
            gst::MessageView::Error(error) => {
                let _ = pipeline.set_state(gst::State::Null);
                return Err(format!("{what}: {}", error.error()));
            }
            gst::MessageView::Application(said)
                if said
                    .structure()
                    .is_some_and(|s| s.name() == "ghostly-flowing") =>
            {
                return Ok(());
            }
            _ => {}
        }
    }
}

fn launch(description: &str) -> Result<gst::Pipeline, String> {
    gst::init().map_err(|e| e.to_string())?;
    gst::parse::launch(description)
        .map_err(|e| e.to_string())?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "Not a pipeline".to_string())
}

fn element<T: IsA<gst::Element>>(pipeline: &gst::Pipeline, name: &str) -> Result<T, String> {
    pipeline
        .by_name(name)
        .and_then(|e| e.downcast::<T>().ok())
        .ok_or_else(|| format!("No {name}"))
}

/// Hands every buffer an appsink gets to `each`.
fn each_buffer(appsink: &gst_app::AppSink, each: impl Fn(&gst::BufferRef) + Send + Sync + 'static) {
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |appsink| {
                let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(buffer) = sample.buffer() {
                    each(buffer);
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
}

fn bytes_of(buffer: &gst::BufferRef) -> Option<Vec<u8>> {
    buffer
        .map_readable()
        .ok()
        .map(|map| map.as_slice().to_vec())
}

fn stop(pipeline: gst::Pipeline) {
    let _ = pipeline.set_state(gst::State::Null);
}

/// How many of a pipeline's errors and warnings reach the log: the first ones say why, the rest repeat them.
const SAID_AT_MOST: u64 = 8;

/// Logs a playing pipeline's errors and warnings. Nothing else reads its bus once it plays, so a decoder that
/// cannot negotiate or a camera that fails a moment later stopped without a word. Everything stays on the bus
/// (`start` and `start_capturing` read the error that kept a pipeline from starting). `heard` gets what a `level`
/// in it reads ([`loudness`]); those messages leave the bus, or it would fill with twelve a second.
fn watch(pipeline: &gst::Pipeline, what: &'static str, heard: Option<Heard>) {
    watch_device(pipeline, what, heard, None);
}

/// Called once, on a pipeline's first error: its device stopped (unplugged, a bus error after it ran).
type Failed = Arc<dyn Fn() + Send + Sync>;

/// [`watch`] for a camera's or a microphone's pipeline: `failed` hears its first error, so the page can end the
/// track and go on with the default (`useCallDevices`). An error while it starts is the start's ([`start_with`]
/// tries the default): `failed` is for the caller to ignore until the pipeline is the one in use.
fn watch_device(
    pipeline: &gst::Pipeline,
    what: &'static str,
    heard: Option<Heard>,
    failed: Option<Failed>,
) {
    let Some(bus) = pipeline.bus() else { return };
    let said = AtomicU64::new(0);
    let told = AtomicBool::new(false);
    bus.set_sync_handler(move |_, message| {
        if let Some(heard) = &heard {
            if let Some(level) = loudness(message) {
                heard(level);
                return gst::BusSyncReply::Drop;
            }
        }
        let (level, error, debug) = match message.view() {
            gst::MessageView::Error(e) => ("error", e.error().to_string(), e.debug()),
            gst::MessageView::Warning(w) => ("warning", w.error().to_string(), w.debug()),
            _ => return gst::BusSyncReply::Pass,
        };
        if level == "error" && !told.swap(true, Ordering::Relaxed) {
            if let Some(failed) = &failed {
                failed();
            }
        }
        if said.fetch_add(1, Ordering::Relaxed) < SAID_AT_MOST {
            let from = message
                .src()
                .map(|s| s.name().to_string())
                .unwrap_or_default();
            crate::diagnostics::log(&format!(
                "native call: {what} {level} from {from}: {error} ({})",
                debug.as_deref().unwrap_or("")
            ));
        }
        gst::BusSyncReply::Pass
    });
}

/// `description` with the device named `name` where `{device}` is: GStreamer makes its element from the device
/// (`pulsesrc device=…`, `v4l2src device=…`, `pipewiresrc path=…`), so it is linked in by hand, after a queue
/// standing in its place.
fn with_device(description: &str, kind: Kind, name: &str) -> Result<gst::Pipeline, String> {
    let device = devices::element(kind, name).ok_or("there is none by that name")?;
    let pipeline = launch(&description.replace("{device}", "queue name=device"))?;
    let slot: gst::Element = element(&pipeline, "device")?;
    pipeline.add(&device).map_err(|e| e.to_string())?;
    let linked = if kind == Kind::Speaker {
        slot.link(&device)
    } else {
        device.link(&slot)
    };
    linked.map_err(|e| e.to_string())?;
    Ok(pipeline)
}

/// Plays `description` with the `kind` named `wanted` where `{device}` is, or with `default` when there is no
/// such device or it will not start, a camera or microphone failing in its first moments included
/// ([`start_capturing`]; said in the log; the page sees it in what is used). `ready` sets the
/// pipeline up before it plays. Returns it and the name of the device it uses, None for the default.
fn start_with(
    what: &str,
    description: &str,
    kind: Kind,
    wanted: Option<&str>,
    default: &str,
    ready: impl Fn(&gst::Pipeline) -> Result<(), String>,
) -> Result<(gst::Pipeline, Option<String>), String> {
    if let Some(name) = wanted {
        let chosen = with_device(description, kind, name).and_then(|pipeline| {
            ready(&pipeline)?;
            // A speaker's sound comes with the peer's: nothing flows to wait for.
            if kind == Kind::Speaker {
                start(&pipeline, what)?;
            } else {
                start_capturing(&pipeline, what)?;
            }
            Ok(pipeline)
        });
        match chosen {
            Ok(pipeline) => return Ok((pipeline, Some(name.to_string()))),
            Err(error) => crate::diagnostics::log(&format!(
                "native call: the {} \"{name}\": {error}; the default instead",
                kind.noun()
            )),
        }
    }
    let pipeline = launch(&description.replace("{device}", default))?;
    ready(&pipeline)?;
    start(&pipeline, what)?;
    Ok((pipeline, None))
}

/// A camera, open until dropped; its frames go to the call it is attached to, if any.
pub struct Camera {
    pipeline: gst::Pipeline,
    target: Arc<Mutex<Option<gst_app::AppSrc>>>,
    /// The camera's name, None for the default one.
    pub device: Option<String>,
}

impl Camera {
    /// The camera named `wanted`, or the default one. `fake`: a test picture instead of the default
    /// ([`fake_media`]), and the test cameras by name. `preview` gets each frame as a JPEG, past the first only
    /// while the page is in sight ([`PAGE_HIDDEN`]).
    pub fn open(fake: bool, wanted: Option<&str>, preview: Sink) -> Result<Camera, String> {
        Camera::open_while(fake, wanted, preview, &PAGE_HIDDEN)
    }

    /// [`Camera::open`], its preview left out while `hidden` is set, past the first.
    fn open_while(
        fake: bool,
        wanted: Option<&str>,
        preview: Sink,
        hidden: &'static AtomicBool,
    ) -> Result<Camera, String> {
        let description = format!(
            "{{device}} ! videoconvert ! videoscale ! videorate \
             ! video/x-raw,format=I420,width={WIDTH},pixel-aspect-ratio=1/1,framerate={FPS}/1 ! tee name=t \
             t. ! queue leaky=downstream max-size-buffers=2 ! appsink name=out sync=false async=false max-buffers=2 drop=true \
             t. ! queue leaky=downstream max-size-buffers=2 ! jpegenc name=shot quality=70 \
             ! appsink name=preview sync=false async=false max-buffers=2 drop=true"
        );
        let test = |pattern: &str| format!("videotestsrc is-live=true pattern={pattern}");
        let pretend = wanted
            .filter(|_| fake)
            .and_then(|name| FAKE_CAMERAS.iter().find(|(n, _)| *n == name));
        let target: Arc<Mutex<Option<gst_app::AppSrc>>> = Arc::default();
        // Set once the camera has started: a failure before is the start's.
        let started = Arc::new(AtomicBool::new(false));
        let ready =
            |pipeline: &gst::Pipeline| Camera::wire(pipeline, &target, &preview, &started, hidden);
        let (pipeline, device) = match pretend {
            Some((name, pattern)) => {
                let (pipeline, _) = start_with(
                    "The camera",
                    &description,
                    Kind::Camera,
                    None,
                    &test(pattern),
                    ready,
                )?;
                (pipeline, Some(name.to_string()))
            }
            None => {
                let default = if fake {
                    test(FAKE_CAMERAS[0].1)
                } else {
                    "v4l2src".to_string()
                };
                // No camera chosen: the one GStreamer lists first (PipeWire's, libcamera's before a bare V4L2
                // node, `devices::default_camera`), still called the default; `v4l2src` only when that one fails.
                let listed = if wanted.is_none() && !fake {
                    devices::default_camera()
                } else {
                    None
                };
                let (pipeline, device) = start_with(
                    "The camera",
                    &description,
                    Kind::Camera,
                    wanted.or(listed.as_deref()),
                    &default,
                    ready,
                )?;
                (pipeline, if wanted.is_some() { device } else { None })
            }
        };
        started.store(true, Ordering::Relaxed);
        Ok(Camera {
            pipeline,
            target,
            device,
        })
    }

    /// The camera's frames to `target`'s call, and to `preview` (past the first, not while `hidden`); once
    /// `started`, its failure to `preview` too, as `{"ended":"camera"}`.
    fn wire(
        pipeline: &gst::Pipeline,
        target: &Arc<Mutex<Option<gst_app::AppSrc>>>,
        preview: &Sink,
        started: &Arc<AtomicBool>,
        hidden: &'static AtomicBool,
    ) -> Result<(), String> {
        let (page, started) = (preview.clone(), started.clone());
        let failed: Failed = Arc::new(move || {
            if started.load(Ordering::Relaxed) {
                page(
                    serde_json::json!({ "ended": "camera" })
                        .to_string()
                        .into_bytes(),
                );
            }
        });
        watch_device(pipeline, "the camera", None, Some(failed));
        let to = target.clone();
        element::<gst_app::AppSink>(pipeline, "out")?.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |appsink| {
                    let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let src = to.lock().unwrap().clone();
                    if let (Some(src), Some(buffer)) = (src, sample.buffer()) {
                        // The call's own clock times it (do-timestamp): this pipeline's times mean nothing there.
                        let mut buffer = buffer.copy();
                        {
                            let buffer = buffer.make_mut();
                            buffer.set_pts(gst::ClockTime::NONE);
                            buffer.set_dts(gst::ClockTime::NONE);
                            buffer.set_duration(gst::ClockTime::NONE);
                        }
                        let caps = sample.caps_owned();
                        let mut next = gst::Sample::builder().buffer(&buffer);
                        if let Some(caps) = &caps {
                            next = next.caps(caps);
                        }
                        let _ = src.push_sample(&next.build());
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let preview = preview.clone();
        let sent = out_of_sight(&element(pipeline, "shot")?, "sink", hidden)?;
        each_buffer(&element(pipeline, "preview")?, move |buffer| {
            if let Some(jpeg) = bytes_of(buffer) {
                sent.store(true, Ordering::Relaxed);
                preview(jpeg);
            }
        });
        Ok(())
    }

    /// Sends the frames to this call's video input, or nowhere.
    pub fn attach(&self, to: Option<gst_app::AppSrc>) {
        *self.target.lock().unwrap() = to;
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        self.attach(None);
        stop(self.pipeline.clone());
    }
}

/// Reads how loud a call's sound is where it passes, every 80 ms as Settings' meter does ([`watch`] hears it).
const LEVEL: &str = "level interval=80000000 post-messages=true";

/// A microphone's loudness for Settings' meter: `level` reports it every 80 ms, and nothing goes anywhere else.
const METER: &str = "{device} ! queue ! audioconvert ! audioresample ! audio/x-raw,channels=1 \
     ! level interval=80000000 post-messages=true ! fakesink sync=false async=false";

/// How loud a `level` reading is on the page's meter (`voiceLevel` in core): the RMS in dB as a linear RMS,
/// times four, at most 1. Silence (-inf dB) is 0.
pub fn meter_level(rms_db: f64) -> f64 {
    if !rms_db.is_finite() {
        return 0.0;
    }
    (10f64.powf(rms_db / 20.0) * 4.0).min(1.0)
}

/// Where a `level` reading goes: how loud, 0 to 1.
type Heard = Arc<dyn Fn(f64) + Send + Sync>;

/// How loud the sound passing a `level` element is, from the message it posts ([`meter_level`] of its loudest
/// channel). None for any other message.
fn loudness(message: &gst::Message) -> Option<f64> {
    let gst::MessageView::Element(element) = message.view() else {
        return None;
    };
    let reading = element.structure().filter(|s| s.name() == "level")?;
    let rms = reading.get::<gst::glib::ValueArray>("rms").ok()?;
    let loudest = rms
        .iter()
        .filter_map(|v| v.get::<f64>().ok())
        .fold(f64::NEG_INFINITY, f64::max);
    Some(meter_level(loudest))
}

/// A microphone open for Settings' meter, until dropped.
pub struct Meter {
    pipeline: gst::Pipeline,
    /// The microphone's name, None for the default one.
    pub device: Option<String>,
}

impl Meter {
    /// The microphone named `wanted`, or the default one (the test tone with `fake`, as in a call). `levels`
    /// gets its loudness, 0 to 1, as JSON (`{"level":0.4}`), at most about 12 times a second ([`meter_says`]).
    pub fn open(fake: bool, wanted: Option<&str>, levels: Sink) -> Result<Meter, String> {
        let default = if fake { TONE } else { "autoaudiosrc" };
        let (pipeline, device) = start_with(
            "The microphone",
            METER,
            Kind::Microphone,
            wanted,
            default,
            |pipeline| {
                let heard = meter_says(levels.clone(), &PAGE_HIDDEN);
                // Read where `level` posts them; anything else (an error) stays on the bus for `start`.
                pipeline
                    .bus()
                    .ok_or("No bus")?
                    .set_sync_handler(move |_, message| {
                        let Some(level) = loudness(message) else {
                            return gst::BusSyncReply::Pass;
                        };
                        heard(level);
                        gst::BusSyncReply::Drop
                    });
                Ok(())
            },
        )?;
        Ok(Meter { pipeline, device })
    }
}

/// Where a meter's readings go on their way to the page: in hundredths, as the page draws them, and only when that
/// changes, so silence is said once. None while the page is out of sight (`hidden`, [`PAGE_HIDDEN`]): each one is an
/// eval in the page and a redraw of a meter nobody sees. Back in sight, the next reading is said.
fn meter_says(levels: Sink, hidden: &'static AtomicBool) -> Heard {
    let last = AtomicU64::new(u64::MAX);
    Arc::new(move |level: f64| {
        if hidden.load(Ordering::Relaxed) {
            last.store(u64::MAX, Ordering::Relaxed);
            return;
        }
        let hundredths = (level * 100.0).round() as u64;
        if last.swap(hundredths, Ordering::Relaxed) == hundredths {
            return;
        }
        levels(
            serde_json::json!({ "level": hundredths as f64 / 100.0 })
                .to_string()
                .into_bytes(),
        );
    })
}

impl Drop for Meter {
    fn drop(&mut self) {
        stop(self.pipeline.clone());
        if let Some(bus) = self.pipeline.bus() {
            bus.unset_sync_handler();
        }
    }
}

/// The speakers' test: a tone, a second long.
const SPEAKER_TEST: &str =
    "audiotestsrc wave=sine freq=660 volume=0.3 samplesperbuffer=4800 num-buffers=10 \
     ! audio/x-raw,rate=48000,channels=1 ! audioconvert ! audioresample ! {device}";

/// Plays the speakers' test on the speaker named `wanted`, or the default one (nothing heard with `fake`, as in
/// a call). Returns once it has played, with the name of the speaker it played on (None: the default). Blocking.
///
/// A tone, not the page's own test sound: that one is a file for the WebView, which GStreamer would need a
/// decoder from another plugin set to play.
pub fn test_speaker(fake: bool, wanted: Option<&str>) -> Result<Option<String>, String> {
    let default = if fake {
        "fakesink sync=true async=false"
    } else {
        "autoaudiosink"
    };
    let (pipeline, device) = start_with(
        "The speakers",
        SPEAKER_TEST,
        Kind::Speaker,
        wanted,
        default,
        |_| Ok(()),
    )?;
    let ended = pipeline.bus().and_then(|bus| {
        bus.timed_pop_filtered(
            gst::ClockTime::from_seconds(5),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        )
    });
    stop(pipeline);
    match ended.as_ref().map(|message| message.view()) {
        Some(gst::MessageView::Eos(_)) => Ok(device),
        Some(gst::MessageView::Error(error)) => Err(format!("The speakers: {}", error.error())),
        _ => Err("The speakers did not finish the tone".into()),
    }
}

/// How much went each way: audio packets and video frames sent, decoded audio buffers and pictures received.
#[derive(Default)]
struct Counts {
    audio_sent: AtomicU64,
    video_sent: AtomicU64,
    audio_received: AtomicU64,
    video_received: AtomicU64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub audio_sent: u64,
    pub video_sent: u64,
    pub audio_received: u64,
    pub video_received: u64,
    pub ice: String,
    pub muted: bool,
    /// The devices in use, by name; None is the default (or, for the speaker, no sound yet).
    pub microphone: Option<String>,
    pub speaker: Option<String>,
}

/// The peer's sound, playing: where its RTP goes, and on which speaker.
struct Playing {
    rtp: gst_app::AppSrc,
    pipeline: gst::Pipeline,
    payload_type: u8,
    device: Option<String>,
}

/// What the call's handler and its tasks share.
struct Shared {
    fake: bool,
    events: Sink,
    counts: Counts,
    ice: Mutex<String>,
    told_connected: AtomicBool,
    /// The candidates gathered so far, and whether gathering is complete.
    gathering: Gathering,
    receiving: Mutex<Vec<gst::Pipeline>>,
    /// The speaker chosen for the peer's sound, by name (None: the default).
    speaker: Mutex<Option<String>>,
    /// The peer's sound, once it arrives; replaced when the speaker changes.
    sound: Mutex<Option<Playing>>,
    /// The peer takes our pictures (`Call::send_pictures`).
    pictures: AtomicBool,
    /// The page draws who is speaking (`Call::set_levels`): the levels are said only then.
    levels: AtomicBool,
    closed: AtomicBool,
}

impl Shared {
    /// Tells the page the ICE state, as its RTCPeerConnection would say it.
    fn say(&self, state: &str) {
        let mut current = self.ice.lock().unwrap();
        if *current == state || self.closed.load(Ordering::Relaxed) {
            return;
        }
        if state == "connected" || state == "completed" {
            self.told_connected.store(true, Ordering::Relaxed);
        }
        *current = state.to_string();
        crate::diagnostics::log(&format!("native call: {state}"));
        (self.events)(serde_json::json!({ "ice": state }).to_string().into_bytes());
    }

    /// Where a side's loudness goes on its way to the page, for who is speaking: `{"levels":{"mic":0.4}}`, 0 to 1
    /// as Settings' meter reads it. `side` is "mic" for what the microphone sends (silence while muted) and
    /// "peer" for the peer's sound. A level is said when it changes, so silence is said once. None is said while
    /// the page is out of sight ([`PAGE_HIDDEN`]) or draws no ring (a video call; `Call::set_levels`): a voice
    /// changes its level at nearly every reading, 25 evals a second for both sides. Back in sight or asked again,
    /// the next reading is said.
    fn hears(self: &Arc<Self>, side: &'static str) -> Heard {
        self.hears_while(side, &PAGE_HIDDEN)
    }

    /// [`Shared::hears`], none said while `hidden` is set.
    fn hears_while(self: &Arc<Self>, side: &'static str, hidden: &'static AtomicBool) -> Heard {
        let shared = self.clone();
        let last = AtomicU64::new(u64::MAX);
        Arc::new(move |level: f64| {
            if hidden.load(Ordering::Relaxed) || !shared.levels.load(Ordering::Relaxed) {
                last.store(u64::MAX, Ordering::Relaxed);
                return;
            }
            let hundredths = (level * 100.0).round() as u64;
            if last.swap(hundredths, Ordering::Relaxed) == hundredths
                || shared.closed.load(Ordering::Relaxed)
            {
                return;
            }
            let levels = serde_json::json!({ "levels": { side: hundredths as f64 / 100.0 } });
            (shared.events)(levels.to_string().into_bytes());
        })
    }

    /// Tells the page a device the call uses stopped mid-call: `{"ended":"microphone"}`.
    fn ended(&self, device: &str) {
        if !self.closed.load(Ordering::Relaxed) {
            (self.events)(
                serde_json::json!({ "ended": device })
                    .to_string()
                    .into_bytes(),
            );
        }
    }

    /// Media arrived, so the call is up, whatever ICE has managed to say.
    fn media_arrived(&self) {
        if !self.told_connected.load(Ordering::Relaxed) {
            self.say("connected");
        }
    }
}

struct Handler(Arc<Shared>);

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            self.0.gathering.add(init.candidate);
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.0.gathering.complete();
        }
    }

    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        self.0.say(&state.to_string());
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        tokio::spawn(receive(self.0.clone(), track));
    }
}

/// One incoming track: its RTP through a jitter buffer and a decoder, to the speakers or to the page.
async fn receive(shared: Arc<Shared>, track: Arc<dyn TrackRemote>) {
    let video = track.kind().await == RtpCodecKind::Video;
    let decoded = Arc::new(AtomicBool::new(false));
    let (keyframe_tx, keyframe_rx) = mpsc::unbounded_channel::<()>();
    let mut keyframe_rx = Some(keyframe_rx);
    let mut input: Option<gst_app::AppSrc> = None;
    let mut first = true;
    while let Some(event) = track.poll().await {
        if shared.closed.load(Ordering::Relaxed) {
            break;
        }
        let TrackRemoteEvent::OnRtpPacket(packet) = event else {
            continue;
        };
        if first {
            // Whether the peer's media reaches us at all, apart from whether it decodes.
            first = false;
            crate::diagnostics::log(&format!(
                "native call: the peer's {} arrives: ssrc {}, payload type {}",
                if video { "video" } else { "sound" },
                packet.header.ssrc,
                packet.header.payload_type
            ));
        }
        if !video {
            // The sound's pipeline changes with the speaker: read each time.
            let rtp = match playing(&shared, packet.header.payload_type) {
                Ok(rtp) => rtp,
                Err(error) => {
                    crate::diagnostics::log(&format!("native call: no audio receiver: {error}"));
                    return;
                }
            };
            if let Ok(bytes) = packet.marshal() {
                let _ = rtp.push_buffer(gst::Buffer::from_slice(bytes));
            }
            continue;
        }
        if input.is_none() {
            match receiver(
                &shared,
                true,
                packet.header.payload_type,
                decoded.clone(),
                keyframe_tx.clone(),
            ) {
                Ok((src, pipeline, _)) => {
                    shared.receiving.lock().unwrap().push(pipeline);
                    input = Some(src);
                }
                Err(error) => {
                    crate::diagnostics::log(&format!("native call: no video receiver: {error}"));
                    return;
                }
            }
            if let Some(mut asked) = keyframe_rx.take() {
                // Keyframes: asked for until a picture shows, then whenever the depayloader lost one.
                let (track, decoded, ssrc) = (track.clone(), decoded.clone(), packet.header.ssrc);
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            request = asked.recv() => if request.is_none() { break },
                            _ = tokio::time::sleep(KEYFRAME_UNTIL_PICTURE) => if decoded.load(Ordering::Relaxed) { continue },
                        }
                        let pli = PictureLossIndication {
                            sender_ssrc: 0,
                            media_ssrc: ssrc,
                        };
                        if track.write_rtcp(vec![Box::new(pli)]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        }
        if let (Some(src), Ok(bytes)) = (&input, packet.marshal()) {
            let _ = src.push_buffer(gst::Buffer::from_slice(bytes));
        }
    }
}

/// Where the peer's sound goes now, started on the chosen speaker with its first packet.
fn playing(shared: &Arc<Shared>, payload_type: u8) -> Result<gst_app::AppSrc, String> {
    let mut sound = shared.sound.lock().unwrap();
    if let Some(playing) = &*sound {
        return Ok(playing.rtp.clone());
    }
    if shared.closed.load(Ordering::Relaxed) {
        return Err("The call was closed".into());
    }
    let (keyframes, _) = mpsc::unbounded_channel();
    let (rtp, pipeline, device) = receiver(shared, false, payload_type, Arc::default(), keyframes)?;
    *sound = Some(Playing {
        rtp: rtp.clone(),
        pipeline,
        payload_type,
        device,
    });
    Ok(rtp)
}

/// A pipeline for one incoming track, playing: its RTP input, and for sound, the speaker it plays on.
fn receiver(
    shared: &Arc<Shared>,
    video: bool,
    payload_type: u8,
    decoded: Arc<AtomicBool>,
    keyframes: mpsc::UnboundedSender<()>,
) -> Result<(gst_app::AppSrc, gst::Pipeline, Option<String>), String> {
    let description = if video {
        format!(
            "appsrc name=rtp is-live=true format=time do-timestamp=true \
             caps=\"application/x-rtp,media=(string)video,clock-rate=(int)90000,encoding-name=(string)VP8,payload=(int){payload_type}\" \
             ! rtpjitterbuffer latency=100 ! rtpvp8depay request-keyframe=true wait-for-keyframe=true ! vp8dec name=decoder \
             ! {}",
            shown()
        )
    } else {
        format!(
            "appsrc name=rtp is-live=true format=time do-timestamp=true \
             caps=\"application/x-rtp,media=(string)audio,clock-rate=(int)48000,encoding-name=(string)OPUS,payload=(int){payload_type}\" \
             ! rtpjitterbuffer latency=60 ! rtpopusdepay ! opusdec plc=true name=decoder \
             ! {LEVEL} ! audioconvert ! audioresample ! {{device}}"
        )
    };
    let ready = |pipeline: &gst::Pipeline| receiving(shared, pipeline, video, &decoded, &keyframes);
    if video {
        let pipeline = launch(&description)?;
        refuse_large(&element(&pipeline, "decoder")?)?;
        ready(&pipeline)?;
        start(&pipeline, "The picture")?;
        return Ok((element(&pipeline, "rtp")?, pipeline, None));
    }
    let wanted = shared.speaker.lock().unwrap().clone();
    let default = if shared.fake {
        "fakesink sync=true async=false"
    } else {
        "autoaudiosink"
    };
    let (pipeline, device) = start_with(
        "The speakers",
        &description,
        Kind::Speaker,
        wanted.as_deref(),
        default,
        ready,
    )?;
    Ok((element(&pipeline, "rtp")?, pipeline, device))
}

/// The size a VP8 keyframe says its pictures are (RFC 6386 § 9.1); none for any other frame.
fn keyframe_size(frame: &[u8]) -> Option<(u64, u64)> {
    if frame.len() < 10 || frame[0] & 1 != 0 || frame[3..6] != [0x9d, 0x01, 0x2a] {
        return None;
    }
    let size = |at: usize| u64::from(u16::from_le_bytes([frame[at], frame[at + 1]]) & 0x3fff);
    Some((size(6), size(8)))
}

/// Leaves a peer's pictures larger than DECODED_MOST out before `decoder` decodes them: from a keyframe that
/// large to the next keyframe that is not (the frames between are drawn on it).
fn refuse_large(decoder: &gst::Element) -> Result<(), String> {
    let refused = AtomicBool::new(false);
    let said = AtomicBool::new(false);
    decoder
        .static_pad("sink")
        .ok_or("No decoder input")?
        .add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            let size = match &info.data {
                Some(gst::PadProbeData::Buffer(buffer)) => buffer
                    .map_readable()
                    .ok()
                    .and_then(|frame| keyframe_size(&frame)),
                _ => None,
            };
            if let Some((width, height)) = size {
                let large = width * height > DECODED_MOST;
                refused.store(large, Ordering::Relaxed);
                if large && !said.swap(true, Ordering::Relaxed) {
                    crate::diagnostics::log(&format!(
                        "native call: the peer's video is {width}×{height}, too large to decode"
                    ));
                }
            }
            if refused.load(Ordering::Relaxed) {
                gst::PadProbeReturn::Drop
            } else {
                gst::PadProbeReturn::Ok
            }
        });
    Ok(())
}

/// What makes the pictures the element named `decoder` gives into JPEGs for the page ([`show`]).
fn shown() -> String {
    format!(
        "videoconvert ! videoscale ! video/x-raw,width=[2,{SHOWN_MAX}],height=[2,{SHOWN_MAX}],pixel-aspect-ratio=1/1 \
         ! jpegenc name=jpeg quality=70 \
         ! appsink name=picture sync=false async=false max-buffers=2 drop=true"
    )
}

/// Whether the page is shown a picture that comes `now`, `next` being when one is due (none before the first).
/// The one after is due a fifteenth of a second after this one was, not after it came: at 30 a second every
/// second picture comes right when one is due, a hair early half the time, and counting from when it came showed
/// 12 a second, in gaps of 66 and 100 ms. SHOWN_EARLY is that hair; half the gap of 60 a second, so those are
/// never taken a picture early. After a pause the count starts again, rather than catch up.
fn due(next: &mut Option<Instant>, now: Instant) -> bool {
    let every = Duration::from_secs(1) / SHOWN_FPS;
    *next = Some(match *next {
        Some(at) if now + SHOWN_EARLY < at => return false,
        Some(at) if now < at + every => at + every,
        _ => now + every,
    });
    true
}

/// The peer's pictures to the page, as JPEGs: at most SHOWN_FPS a second (videorate's drop-only asserts on 1.20
/// here). The others are left out as they leave the decoder, before any is scaled or made a JPEG: a browser
/// sends 30 a second.
fn show(pipeline: &gst::Pipeline, page: Sink) -> Result<(), String> {
    show_while(pipeline, page, &PAGE_HIDDEN)
}

/// [`show`], past the first picture none while `hidden` is set.
fn show_while(
    pipeline: &gst::Pipeline,
    page: Sink,
    hidden: &'static AtomicBool,
) -> Result<(), String> {
    let next = Mutex::new(None::<Instant>);
    let sent = out_of_sight(&element(pipeline, "decoder")?, "src", hidden)?;
    element::<gst::Element>(pipeline, "decoder")?
        .static_pad("src")
        .ok_or("No decoder output")?
        .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            if due(&mut next.lock().unwrap(), Instant::now()) {
                gst::PadProbeReturn::Ok
            } else {
                gst::PadProbeReturn::Drop
            }
        });
    each_buffer(&element(pipeline, "picture")?, move |buffer| {
        if let Some(jpeg) = bytes_of(buffer) {
            sent.store(true, Ordering::Relaxed);
            page(jpeg);
        }
    });
    Ok(())
}

/// Leaves out what passes `element`'s `pad` while the page is out of sight (`hidden`), once a picture has gone to
/// it: the flag returned, which whoever hands the page its pictures sets.
fn out_of_sight(
    element: &gst::Element,
    pad: &str,
    hidden: &'static AtomicBool,
) -> Result<Arc<AtomicBool>, String> {
    let sent = Arc::new(AtomicBool::new(false));
    let gone = sent.clone();
    element
        .static_pad(pad)
        .ok_or("No pad to leave pictures out at")?
        .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            if hidden.load(Ordering::Relaxed) && gone.load(Ordering::Relaxed) {
                gst::PadProbeReturn::Drop
            } else {
                gst::PadProbeReturn::Ok
            }
        });
    Ok(sent)
}

/// Counts what a receiving pipeline decodes and, for pictures, sends them to the page and asks for keyframes.
fn receiving(
    shared: &Arc<Shared>,
    pipeline: &gst::Pipeline,
    video: bool,
    decoded: &Arc<AtomicBool>,
    keyframes: &mpsc::UnboundedSender<()>,
) -> Result<(), String> {
    if video {
        watch(pipeline, "the peer's video", None);
    } else {
        watch(pipeline, "the peer's sound", Some(shared.hears("peer")));
    }
    let src: gst_app::AppSrc = element(pipeline, "rtp")?;
    let counting = shared.clone();
    let decoder: gst::Element = element(pipeline, "decoder")?;
    let decoded = decoded.clone();
    decoder
        .static_pad("src")
        .ok_or("No decoder output")?
        .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            let counts = &counting.counts;
            let count = if video {
                &counts.video_received
            } else {
                &counts.audio_received
            };
            if count.fetch_add(1, Ordering::Relaxed) == 0 {
                crate::diagnostics::log(&format!(
                    "native call: the peer's {} decodes",
                    if video { "video" } else { "sound" }
                ));
            }
            decoded.store(true, Ordering::Relaxed);
            counting.media_arrived();
            gst::PadProbeReturn::Ok
        });
    if video {
        show(pipeline, shared.events.clone())?;
        // The depayloader lost a frame and wants a keyframe: that goes to the sender as a PLI.
        let keyframes = keyframes.clone();
        src.static_pad("src").ok_or("No RTP output")?.add_probe(
            gst::PadProbeType::EVENT_UPSTREAM,
            move |_, info| {
                if let Some(gst::PadProbeData::Event(event)) = &info.data {
                    if event
                        .structure()
                        .is_some_and(|s| s.name() == "GstForceKeyUnit")
                    {
                        let _ = keyframes.send(());
                    }
                }
                gst::PadProbeReturn::Ok
            },
        );
    }
    Ok(())
}

/// The payload types an offer gives Opus and VP8, so the answer sends what the offerer will read as such.
pub fn offered_payload_types(sdp: &str) -> (u8, u8) {
    let (mut opus, mut vp8, mut kind) = (None, None, "");
    for line in sdp.lines() {
        if line.starts_with("m=audio") {
            kind = "audio";
        } else if line.starts_with("m=video") {
            kind = "video";
        } else if let Some(rest) = line.strip_prefix("a=rtpmap:") {
            let mut parts = rest.splitn(2, ' ');
            let (Some(pt), Some(codec)) = (parts.next(), parts.next()) else {
                continue;
            };
            let Ok(pt) = pt.parse::<u8>() else { continue };
            let codec = codec.to_ascii_lowercase();
            if kind == "audio" && opus.is_none() && codec.starts_with("opus/48000") {
                opus = Some(pt);
            }
            if kind == "video" && vp8.is_none() && codec.starts_with("vp8/90000") {
                vp8 = Some(pt);
            }
        }
    }
    (opus.unwrap_or(OPUS_PT), vp8.unwrap_or(VP8_PT))
}

/// Whether the peer's description takes our pictures: its video section open both ways, or only to receive. A
/// peer that takes none (`vr: 0`, a bot) has the section rebuilt `a=inactive`. No video section: as before.
pub fn takes_pictures(sdp: &str) -> bool {
    let mut video = false;
    for line in sdp.lines().map(str::trim_end) {
        if line.starts_with("m=") {
            video = line.starts_with("m=video");
        } else if video && (line == "a=inactive" || line == "a=sendonly") {
            return false;
        }
    }
    true
}

/// A description with every section's DTLS role (`a=setup:`) said as `setup`.
///
/// The Desktop's offer says `active`, not webrtc-rs's `actpass`: the offerer is the DTLS client and starts the
/// handshake on the pair its own ICE nominated. A peer that was the client sent its first flight on the first pair
/// that worked for it, which webrtc-rs drops until it has a selected pair of its own; the peer sent it again a second
/// later, and the call connected that much late. The answer to an `active` offer is `passive`.
fn with_setup(sdp: &str, setup: &str) -> String {
    sdp.split_inclusive('\n')
        .map(|line| {
            if line.starts_with("a=setup:") {
                let end = &line[line.trim_end().len()..];
                format!("a=setup:{setup}{end}")
            } else {
                line.to_string()
            }
        })
        .collect()
}

/// The local description as the page's signal needs it (`extractParamsFromSdp`): each media section with an
/// SSRC line, and every candidate gathered, `udp` in lower case as browsers write it, at the end.
pub fn describe(sdp: &str, gathered: &[String], ssrcs: (u32, u32)) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut candidates: Vec<String> = Vec::new();
    let mut section = "";
    let mut has_ssrc = false;
    let close = |out: &mut Vec<String>, section: &str, has_ssrc: bool| match (section, has_ssrc) {
        ("audio", false) => out.push(format!("a=ssrc:{} cname:ghostly", ssrcs.0)),
        ("video", false) => out.push(format!("a=ssrc:{} cname:ghostly", ssrcs.1)),
        _ => {}
    };
    let mut candidate = |line: &str| {
        let line = line.trim_start_matches("a=");
        let line = line.strip_prefix("candidate:").unwrap_or(line);
        let parts: Vec<String> = line
            .split(' ')
            .enumerate()
            .map(|(i, p)| {
                if i == 2 {
                    p.to_ascii_lowercase()
                } else {
                    p.to_string()
                }
            })
            .collect();
        // A wildcard address (a socket bound to `[::]` on a machine with no IPv6) cannot be dialled.
        if parts
            .get(4)
            .and_then(|a| a.parse::<std::net::IpAddr>().ok())
            .is_some_and(|a| a.is_unspecified())
        {
            return;
        }
        let line = format!("a=candidate:{}", parts.join(" "));
        if !candidates.contains(&line) {
            candidates.push(line);
        }
    };
    for line in sdp.lines().map(str::trim_end).filter(|l| !l.is_empty()) {
        if line.starts_with("m=") {
            close(&mut out, section, has_ssrc);
            section = if line.starts_with("m=audio") {
                "audio"
            } else if line.starts_with("m=video") {
                "video"
            } else {
                "other"
            };
            has_ssrc = false;
        }
        if line.starts_with("a=ssrc:") {
            has_ssrc = true;
        }
        if line.starts_with("a=candidate:") {
            candidate(line);
            continue;
        }
        if line == "a=end-of-candidates" {
            continue;
        }
        out.push(line.to_string());
    }
    close(&mut out, section, has_ssrc);
    for line in gathered {
        candidate(line);
    }
    // The signal carries the first host candidate only (`extractParamsFromSdp`): IPv4 first, as browsers put it.
    candidates.sort_by_key(|line| {
        let parts: Vec<&str> = line.split(' ').collect();
        let host = parts.get(7) == Some(&"host");
        let ipv6 = parts.get(4).is_some_and(|a| a.contains(':'));
        (!host, ipv6)
    });
    out.extend(candidates);
    out.join("\r\n") + "\r\n"
}

fn codec(kind: RtpCodecKind, payload_type: u8) -> RTCRtpCodecParameters {
    let feedback = |typ: &str, parameter: &str| RTCPFeedback {
        typ: typ.into(),
        parameter: parameter.into(),
    };
    RTCRtpCodecParameters {
        rtp_codec: if kind == RtpCodecKind::Audio {
            RTCRtpCodec {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48000,
                channels: 2,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                rtcp_feedback: vec![],
            }
        } else {
            RTCRtpCodec {
                mime_type: MIME_TYPE_VP8.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: vec![
                    feedback("goog-remb", ""),
                    feedback("ccm", "fir"),
                    feedback("nack", ""),
                    feedback("nack", "pli"),
                ],
            }
        },
        payload_type,
    }
}

/// One of our two tracks, and its SSRC.
struct Outgoing {
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
}

async fn outgoing(
    pc: &Arc<dyn PeerConnection>,
    kind: RtpCodecKind,
    payload_type: u8,
) -> Result<Outgoing, String> {
    let ssrc = rand::random::<u32>();
    let name = if kind == RtpCodecKind::Audio {
        "audio"
    } else {
        "video"
    };
    let track = Arc::new(
        TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "ghostly".to_owned(),
                name.to_owned(),
                name.to_owned(),
                kind,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec: codec(kind, payload_type).rtp_codec,
                    ..Default::default()
                }],
            ),
        )
        .map_err(|e| e.to_string())?,
    );
    pc.add_track(track.clone() as Arc<dyn TrackLocal>)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Outgoing { track, ssrc })
}

/// What an encoder made, on its way to a track.
type Frames = mpsc::Sender<(Bytes, Duration)>;

/// Queues what an encoder makes for the track's writer, while `live` holds (a microphone being replaced
/// stops as its successor starts). GStreamer's threads only queue it.
fn feed(
    appsink: &gst_app::AppSink,
    frames: Frames,
    frame: Duration,
    live: impl Fn() -> bool + Send + Sync + 'static,
) {
    each_buffer(appsink, move |buffer| {
        if !live() {
            return;
        }
        let duration = buffer
            .duration()
            .map(|d| Duration::from_nanos(d.nseconds()))
            .unwrap_or(frame);
        if let Some(bytes) = bytes_of(buffer) {
            // Before the call connects, or when writing falls behind, frames are dropped rather than queued.
            let _ = frames.try_send((Bytes::from(bytes), duration));
        }
    });
}

/// Writes what the encoders feed it to a track, from a task, for the whole call; what comes while `open` does not
/// hold is dropped.
fn writer(
    out: Outgoing,
    payload_type: u8,
    open: impl Fn() -> bool + Send + 'static,
    sent: impl Fn() + Send + 'static,
) -> Frames {
    let (tx, mut rx) = mpsc::channel::<(Bytes, Duration)>(64);
    tokio::spawn(async move {
        let mut failing = false;
        while let Some((data, duration)) = rx.recv().await {
            if !open() {
                continue;
            }
            let sample = Sample {
                data,
                duration,
                ..Sample::new(Instant::now())
            };
            match out
                .track
                .sample_writer(out.ssrc, payload_type)
                .write_sample(&sample)
                .await
            {
                Ok(()) => {
                    failing = false;
                    sent();
                }
                // Until the call connects every write fails; said once each time it starts failing.
                Err(error) if !failing => {
                    failing = true;
                    crate::diagnostics::log(&format!("native call: not sending yet: {error}"));
                }
                Err(_) => {}
            }
        }
    });
    tx
}

/// The microphone to Opus, for the audio track's writer. Its loudness is read after the mute ([`LEVEL`]).
const MICROPHONE: &str = "{device} ! queue ! audioconvert ! audioresample ! volume name=mic \
     ! audio/x-raw,rate=48000,channels=1 ! level interval=80000000 post-messages=true \
     ! opusenc bitrate=32000 frame-size=20 \
     ! appsink name=opus sync=false async=false max-buffers=50 drop=true";

/// The microphone a call sends, playing.
struct Microphone {
    pipeline: gst::Pipeline,
    volume: gst::Element,
    device: Option<String>,
}

/// What a call's microphone pipelines share: where they write, which one is current, and whether it is muted.
struct Voice {
    fake: bool,
    frames: Frames,
    current: Arc<AtomicU64>,
    muted: AtomicBool,
    /// Where each microphone's loudness goes.
    heard: Heard,
    /// Where the current microphone's failure goes (`Shared::ended`).
    failed: Failed,
}

impl Voice {
    /// Starts the microphone named `wanted` (or the default), and makes it the one the call sends.
    fn open(&self, wanted: Option<&str>) -> Result<Microphone, String> {
        let mine = self.current.load(Ordering::Relaxed) + 1;
        let muted = self.muted.load(Ordering::Relaxed);
        let default = if self.fake { TONE } else { "autoaudiosrc" };
        let (pipeline, device) = start_with(
            "The microphone",
            MICROPHONE,
            Kind::Microphone,
            wanted,
            default,
            |p| {
                // Only while it is the one sent: one failing as it starts, or replaced since, is not the call's.
                let (current, failed) = (self.current.clone(), self.failed.clone());
                let failed: Failed = Arc::new(move || {
                    if current.load(Ordering::Relaxed) == mine {
                        failed();
                    }
                });
                watch_device(p, "the microphone", Some(self.heard.clone()), Some(failed));
                element::<gst::Element>(p, "mic")?.set_property("mute", muted);
                let current = self.current.clone();
                feed(
                    &element(p, "opus")?,
                    self.frames.clone(),
                    Duration::from_millis(20),
                    move || current.load(Ordering::Relaxed) == mine,
                );
                Ok(())
            },
        )?;
        self.current.store(mine, Ordering::Relaxed);
        Ok(Microphone {
            volume: element(&pipeline, "mic")?,
            pipeline,
            device,
        })
    }
}

/// One call: a peer connection, and the pipelines that feed it and play what it brings.
pub struct Call {
    pc: Arc<dyn PeerConnection>,
    shared: Arc<Shared>,
    /// Pictures to VP8; cameras come and go at its input.
    send: gst::Pipeline,
    video_in: gst_app::AppSrc,
    voice: Voice,
    /// Held while another microphone opens.
    microphone: Mutex<Microphone>,
    /// The volume of the microphone sent, apart: mute never waits for a microphone opening.
    volume: Mutex<gst::Element>,
    ssrcs: (u32, u32),
    /// The profile has a TURN server: gathering waits for a relay candidate.
    uses_turn: bool,
    /// Hide my IP from contacts: relay candidates only ([`ice_configuration`]).
    relay_only: bool,
}

/// Why a call under Hide my IP from contacts was not made. The page knows them by their first words
/// (`relayFailure` in apps/ui/src/desktop/nativeCalls.ts) and says the relay did not answer.
const NO_TURN: &str = "Hide my IP: no TURN server this app can use";
const NO_RELAY: &str = "Hide my IP: the TURN server gave no relay candidate";

/// The connection's ICE servers and policy. Hide my IP from contacts (`relay_only`, WISP 601 Relay only): the
/// profile's TURN servers alone under the relay policy, so no STUN server is asked and the only candidates
/// gathered are the relay's. Otherwise the built-in STUN server (`stun`, by address), then the profile's own.
fn ice_configuration(
    stun: Vec<String>,
    servers: &[IceServer],
    relay_only: bool,
) -> (Vec<RTCIceServer>, RTCIceTransportPolicy) {
    let own = |server: &IceServer| RTCIceServer {
        urls: server.urls.clone(),
        username: server.username.clone().unwrap_or_default(),
        credential: server.credential.clone().unwrap_or_default(),
    };
    if relay_only {
        return (
            ice::relays(servers).iter().map(own).collect(),
            RTCIceTransportPolicy::Relay,
        );
    }
    let builtin = RTCIceServer {
        urls: stun,
        ..Default::default()
    };
    (
        std::iter::once(builtin)
            .chain(servers.iter().map(own))
            .collect(),
        RTCIceTransportPolicy::All,
    )
}

/// A description with the candidates of this round's gathering alone. On an ICE restart webrtc-rs's description
/// still lists the round before's, ahead of the new ones, though their sockets are gone (and, with a TURN server,
/// their relays freed): the signal keeps the first few of each kind (`pickCallCandidates`), so after a network
/// change a contact was told the old addresses alone.
fn gathered_only(sdp: &str, gathered: &[String]) -> String {
    /// A candidate's address and port.
    fn address(candidate: &str) -> Vec<&str> {
        candidate.split(' ').skip(4).take(2).collect()
    }
    let this_round: Vec<Vec<&str>> = gathered.iter().map(|c| address(c)).collect();
    sdp.split_inclusive('\n')
        .filter(|line| {
            !line.starts_with("a=candidate:") || this_round.contains(&address(line.trim_end()))
        })
        .collect()
}

/// A description with its relay candidates alone: what a relay-only call may tell the peer, whatever webrtc-rs
/// gathered.
fn relay_candidates_only(sdp: &str) -> String {
    sdp.split_inclusive('\n')
        .filter(|line| !line.starts_with("a=candidate:") || line.contains(gather::RELAY))
        .collect()
}

/// The microphone and the speaker a call starts with, by name (None: the default).
#[derive(Default)]
pub struct Devices {
    pub microphone: Option<String>,
    pub speaker: Option<String>,
}

impl Call {
    /// The pipelines playing and the peer connection ready to offer or answer. `fake`: a test tone and nothing
    /// played by default ([`fake_media`]; a device chosen by name is used all the same). `servers`: the profile's
    /// own ICE servers ([`ice::usable`] ones), after the built-in STUN server; with `relay_only` (Hide my IP from
    /// contacts) their TURN servers alone ([`ice_configuration`]). `events` hears the ICE state and
    /// each side's loudness (JSON, [`Shared::hears`]), a microphone that stopped mid-call ([`Shared::ended`]), and
    /// each picture that arrives (JPEG).
    pub async fn new(
        opus_pt: u8,
        vp8_pt: u8,
        fake: bool,
        devices: Devices,
        servers: &[IceServer],
        relay_only: bool,
        events: Sink,
    ) -> Result<Call, String> {
        // Never a direct path instead: the call does not start.
        if relay_only && ice::relays(servers).is_empty() {
            return Err(NO_TURN.into());
        }
        let uses_turn = ice::uses_turn(servers);
        let mut media = MediaEngine::default();
        media
            .register_codec(codec(RtpCodecKind::Audio, opus_pt), RtpCodecKind::Audio)
            .map_err(|e| e.to_string())?;
        media
            .register_codec(codec(RtpCodecKind::Video, vp8_pt), RtpCodecKind::Video)
            .map_err(|e| e.to_string())?;
        let registry = register_default_interceptors(Registry::new(), &mut media)
            .map_err(|e| e.to_string())?;
        let shared = Arc::new(Shared {
            fake,
            events,
            counts: Counts::default(),
            ice: Mutex::new("new".into()),
            told_connected: AtomicBool::new(false),
            gathering: Gathering::default(),
            receiving: Mutex::default(),
            speaker: Mutex::new(devices.speaker),
            sound: Mutex::default(),
            pictures: AtomicBool::new(true),
            levels: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        });
        // By address: webrtc-rs would otherwise resolve the name on its driver, ahead of the host candidates.
        // Not even looked up with relay only.
        let stun = if relay_only {
            Vec::new()
        } else {
            gather::stun_urls(STUN, gather::resolve, STUN_LOOKUP).await
        };
        let (ice_servers, policy) = ice_configuration(stun, servers, relay_only);
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(
                    RTCConfigurationBuilder::new()
                        .with_ice_servers(ice_servers)
                        .with_ice_transport_policy(policy)
                        .build(),
                )
                // An ICE restart (WISP 601, "Reconnecting") gathers anew on sockets bound again: after a
                // network change the interfaces are other ones, and candidates kept from before would name
                // addresses this machine no longer has.
                .with_setting_engine(
                    SettingEngineBuilder::new()
                        .with_discard_local_candidates_during_ice_restart(true)
                        .build(),
                )
                .with_media_engine(media)
                .with_interceptor_registry(registry)
                .with_handler(Arc::new(Handler(shared.clone())))
                .with_udp_addrs(vec!["0.0.0.0:0".to_owned(), "[::]:0".to_owned()])
                .build()
                .await
                .map_err(|e| e.to_string())?,
        );
        let audio = outgoing(&pc, RtpCodecKind::Audio, opus_pt).await?;
        let video = outgoing(&pc, RtpCodecKind::Video, vp8_pt).await?;
        let ssrcs = (audio.ssrc, video.ssrc);

        let counted = shared.clone();
        let voice = Voice {
            fake,
            frames: writer(
                audio,
                opus_pt,
                || true,
                move || {
                    counted.counts.audio_sent.fetch_add(1, Ordering::Relaxed);
                },
            ),
            current: Arc::default(),
            muted: AtomicBool::new(false),
            heard: shared.hears("mic"),
            failed: {
                let shared = shared.clone();
                Arc::new(move || shared.ended("microphone"))
            },
        };
        let (counted, open) = (shared.clone(), shared.clone());
        let pictures = writer(
            video,
            vp8_pt,
            move || open.pictures.load(Ordering::Relaxed),
            move || {
                counted.counts.video_sent.fetch_add(1, Ordering::Relaxed);
            },
        );
        let started = (|| {
            let send = launch(&format!(
                "appsrc name=video is-live=true format=time do-timestamp=true ! valve name=pictures \
                 ! queue leaky=downstream max-size-buffers=4 \
                 ! videoconvert ! vp8enc deadline=1 cpu-used=8 threads=2 target-bitrate=600000 end-usage=cbr keyframe-max-dist={FPS} \
                 ! appsink name=vp8 sync=false async=false max-buffers=10 drop=true"
            ))?;
            feed(
                &element(&send, "vp8")?,
                pictures,
                Duration::from_secs(1) / FPS,
                || true,
            );
            watch(&send, "the video encoder", None);
            start(&send, "The video")?;
            match voice.open(devices.microphone.as_deref()) {
                Ok(microphone) => Ok((send, microphone)),
                Err(error) => {
                    stop(send);
                    Err(error)
                }
            }
        })();
        let (send, microphone) = match started {
            Ok(started) => started,
            Err(error) => {
                let _ = pc.close().await;
                return Err(error);
            }
        };
        Ok(Call {
            pc,
            shared,
            video_in: element(&send, "video")?,
            send,
            voice,
            volume: Mutex::new(microphone.volume.clone()),
            microphone: Mutex::new(microphone),
            ssrcs,
            uses_turn,
            relay_only,
        })
    }

    /// Sends the microphone named `wanted` (None: the default) in place of the one on, muted if the call is.
    /// The old one stops once the new one plays. Returns the name of the one in use (None: the default).
    /// Blocking: GStreamer starts and stops the pipelines.
    pub fn set_microphone(&self, wanted: Option<&str>) -> Result<Option<String>, String> {
        let mut microphone = self.microphone.lock().unwrap();
        if self.shared.closed.load(Ordering::Relaxed) {
            return Err("The call was closed".into());
        }
        let next = self.voice.open(wanted)?;
        self.switch_to(&mut microphone, next);
        crate::diagnostics::log(&format!(
            "native call: microphone {}",
            microphone.device.as_deref().unwrap_or("(default)")
        ));
        Ok(microphone.device.clone())
    }

    /// Makes `next`, just opened, the microphone muted or not: mute may have been pressed while it opened.
    fn switch_to(&self, microphone: &mut Microphone, next: Microphone) {
        {
            let mut volume = self.volume.lock().unwrap();
            *volume = next.volume.clone();
            volume.set_property("mute", self.voice.muted.load(Ordering::Relaxed));
        }
        let previous = std::mem::replace(microphone, next);
        stop(previous.pipeline);
    }

    /// Plays the peer's sound on the speaker named `wanted` (None: the default), from now on. Blocking.
    pub fn set_speaker(&self, wanted: Option<String>) -> Result<(), String> {
        {
            let mut speaker = self.shared.speaker.lock().unwrap();
            if *speaker == wanted {
                return Ok(());
            }
            *speaker = wanted;
        }
        // Held while the new one starts: the sound waits for it rather than going to the old one.
        let mut sound = self.shared.sound.lock().unwrap();
        let Some(payload_type) = sound.as_ref().map(|s| s.payload_type) else {
            // No sound yet: it starts on this speaker.
            return Ok(());
        };
        if self.shared.closed.load(Ordering::Relaxed) {
            return Ok(());
        }
        let (keyframes, _) = mpsc::unbounded_channel();
        let (rtp, pipeline, device) =
            receiver(&self.shared, false, payload_type, Arc::default(), keyframes)?;
        crate::diagnostics::log(&format!(
            "native call: speaker {}",
            device.as_deref().unwrap_or("(default)")
        ));
        let previous = sound.replace(Playing {
            rtp,
            pipeline,
            payload_type,
            device,
        });
        drop(sound);
        if let Some(previous) = previous {
            stop(previous.pipeline);
        }
        Ok(())
    }

    /// Sets our description and waits for its candidates; `restart`: an ICE restart's, which carries this round's
    /// candidates alone ([`gathered_only`]).
    async fn local(
        &self,
        description: RTCSessionDescription,
        restart: bool,
    ) -> Result<String, String> {
        let started = Instant::now();
        self.pc
            .set_local_description(description)
            .await
            .map_err(|e| e.to_string())?;
        // With a TURN server, its relay candidate is the one to wait for, as `waitForIceGathering` does.
        let awaited = if self.uses_turn {
            gather::RELAY
        } else {
            gather::REFLEXIVE
        };
        // Hide my IP from contacts: the relay candidate is the only one there will be, so the wait for it is the
        // whole wait, and without one there is no description: a TURN server that did not answer.
        let bounds = match self.relay_only {
            true => gather::Bounds {
                first: gather::BOUNDS.reflexive,
                ..gather::BOUNDS
            },
            false => gather::BOUNDS,
        };
        let gathered = match self.shared.gathering.wait_for(bounds, awaited).await {
            Err(_) if self.relay_only => return Err(NO_RELAY.into()),
            gathered => gathered?,
        };
        let local = self
            .pc
            .local_description()
            .await
            .ok_or("No local description")?;
        let sdp = match restart {
            true => gathered_only(&local.sdp, &gathered),
            false => local.sdp,
        };
        let mut described = describe(&sdp, &gathered, self.ssrcs);
        if self.relay_only {
            described = relay_candidates_only(&described);
            if !described.contains("a=candidate:") {
                return Err(NO_RELAY.into());
            }
        }
        // Which kinds of candidates went out (not their addresses): why a call never connected, afterwards.
        let kinds: Vec<&str> = described
            .lines()
            .filter(|l| l.starts_with("a=candidate:") && l.split(' ').nth(1) == Some("1"))
            .filter_map(|l| l.split(' ').nth(7))
            .collect();
        crate::diagnostics::log(&format!(
            "native call: {} with {kinds:?} ({} gathered in {} ms)",
            local.sdp_type,
            gathered.len(),
            started.elapsed().as_millis()
        ));
        Ok(described)
    }

    /// Forgets the candidates gathered so far: the description being made waits for this round's own.
    fn gather_anew(&self) {
        self.shared.gathering.anew();
    }

    /// Our offer, gathered: what the page reads its signal from. `restart`: on a call that is up, an offer that
    /// restarts ICE (new credentials, candidates gathered anew) on this same connection.
    pub async fn offer(&self, restart: bool) -> Result<String, String> {
        if restart {
            self.gather_anew();
        }
        let options = restart.then_some(RTCOfferOptions { ice_restart: true });
        let offer = self
            .pc
            .create_offer(options)
            .await
            .map_err(|e| e.to_string())?;
        Ok(with_setup(&self.local(offer, restart).await?, "active"))
    }

    /// Our answer to the peer's offer (rebuilt from its signal), gathered. `restart`: the offer is the peer's ICE
    /// restart on a call that is up, and ICE restarts here with it.
    pub async fn answer(&self, offer: &str, restart: bool) -> Result<String, String> {
        if restart {
            self.gather_anew();
        }
        let offer = RTCSessionDescription::offer(offer.to_owned()).map_err(|e| e.to_string())?;
        let pictures = takes_pictures(&offer.sdp);
        // webrtc-rs answers `active` whatever the offer said; its DTLS is the server all the same.
        let active = offer.sdp.lines().any(|l| l.trim_end() == "a=setup:active");
        self.pc
            .set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        self.send_pictures(pictures);
        let answer = self
            .pc
            .create_answer(None)
            .await
            .map_err(|e| e.to_string())?;
        let answer = self.local(answer, restart).await?;
        Ok(if active {
            with_setup(&answer, "passive")
        } else {
            answer
        })
    }

    /// The peer's answer to our offer. Our offer said `active`, so the answer's side is the DTLS server, as a Desktop
    /// before this one is while its answer says `active`.
    pub async fn accept(&self, answer: &str) -> Result<(), String> {
        let answer = RTCSessionDescription::answer(with_setup(answer, "passive"))
            .map_err(|e| e.to_string())?;
        let pictures = takes_pictures(&answer.sdp);
        self.pc
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;
        self.send_pictures(pictures);
        Ok(())
    }

    /// Encodes and sends the camera's pictures, or none: webrtc-rs sends what it is given on a video section the
    /// peer closed (`vr: 0`), so they stop before the encoder, and those encoded before the answer stay unsent.
    fn send_pictures(&self, on: bool) {
        if self.shared.pictures.swap(on, Ordering::Relaxed) != on {
            crate::diagnostics::log(&format!(
                "native call: {}",
                if on {
                    "pictures sent"
                } else {
                    "the peer takes no picture"
                }
            ));
        }
        if let Ok(valve) = element::<gst::Element>(&self.send, "pictures") {
            valve.set_property("drop", !on);
        }
    }

    /// Not blocking: the window's thread calls it, while another microphone may be opening.
    pub fn set_muted(&self, muted: bool) {
        let volume = self.volume.lock().unwrap();
        self.voice.muted.store(muted, Ordering::Relaxed);
        volume.set_property("mute", muted);
    }

    /// The page draws who is speaking, or no longer does ([`Shared::hears`]). Not blocking, like `set_muted`.
    pub fn set_levels(&self, on: bool) {
        self.shared.levels.store(on, Ordering::Relaxed);
    }

    pub fn video_input(&self) -> gst_app::AppSrc {
        self.video_in.clone()
    }

    pub fn stats(&self) -> Stats {
        let c = &self.shared.counts;
        Stats {
            audio_sent: c.audio_sent.load(Ordering::Relaxed),
            video_sent: c.video_sent.load(Ordering::Relaxed),
            audio_received: c.audio_received.load(Ordering::Relaxed),
            video_received: c.video_received.load(Ordering::Relaxed),
            ice: self.shared.ice.lock().unwrap().clone(),
            muted: self.voice.muted.load(Ordering::Relaxed),
            microphone: self.microphone.lock().unwrap().device.clone(),
            speaker: self
                .shared
                .sound
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|s| s.device.clone()),
        }
    }

    /// What the connection itself counted (webrtc-rs's getStats), by kind: the RTP it sent and received, and
    /// the candidate pair in use with its bytes. It tells pictures that never left from pictures that never
    /// arrived and from pictures that did not decode. (Not the peer's RTCP receiver reports: webrtc-rs 0.21
    /// counted none of them here.)
    pub async fn transport(&self) -> serde_json::Value {
        let report = self.pc.get_stats(Instant::now(), StatsSelector::None).await;
        let kind = |k: RtpCodecKind| {
            if k == RtpCodecKind::Video {
                "video"
            } else {
                "audio"
            }
        };
        let mut out = serde_json::json!({});
        for entry in report.iter() {
            match entry {
                RTCStatsReportEntry::OutboundRtp(s) => {
                    let sent = &s.sent_rtp_stream_stats;
                    out["sent"][kind(sent.rtp_stream_stats.kind)] = serde_json::json!({
                        "ssrc": sent.rtp_stream_stats.ssrc,
                        "packets": sent.packets_sent,
                        "bytes": sent.bytes_sent,
                    });
                }
                RTCStatsReportEntry::InboundRtp(s) => {
                    let received = &s.received_rtp_stream_stats;
                    out["received"][kind(received.rtp_stream_stats.kind)] = serde_json::json!({
                        "ssrc": received.rtp_stream_stats.ssrc,
                        "packets": received.packets_received,
                        "bytes": s.bytes_received,
                        "lost": received.packets_lost,
                    });
                }
                RTCStatsReportEntry::IceCandidatePair(pair) if pair.nominated => {
                    out["pair"]["bytesSent"] = pair.bytes_sent.into();
                    out["pair"]["bytesReceived"] = pair.bytes_received.into();
                    out["pair"]["discardedOnSend"] = pair.packets_discarded_on_send.into();
                }
                _ => {}
            }
        }
        // The path the call took (a LAN, a VPN's addresses, a NAT's): what decides the packet sizes that get through.
        if let Some(pair) = self.selected_pair().await {
            out["pair"]["local"] = pair.0.into();
            out["pair"]["remote"] = pair.1.into();
        }
        out
    }

    /// The candidate pair ICE chose, as `type address:port` on each side.
    async fn selected_pair(&self) -> Option<(String, String)> {
        let sender = self.pc.get_senders().await.into_iter().next()?;
        let dtls = sender.transport().await.ok()??;
        let pair = dtls
            .ice_transport()
            .get_selected_candidate_pair()
            .await
            .ok()??;
        let side = |c: &rtc::peer_connection::transport::RTCIceCandidate| {
            format!("{} {}:{}", c.typ, c.address, c.port)
        };
        Some((side(pair.local()), side(pair.remote())))
    }

    /// Hangs up: the connection closed, every pipeline stopped.
    pub async fn close(&self) {
        if !self.shared.closed.load(Ordering::Relaxed) {
            // What went each way, for a call that showed no picture: in the log afterwards.
            crate::diagnostics::log(&format!(
                "native call: ended, {} {}",
                serde_json::to_string(&self.stats()).unwrap_or_default(),
                self.transport().await
            ));
        }
        self.shared.closed.store(true, Ordering::Relaxed);
        let _ = self.pc.close().await;
        let mut pipelines = std::mem::take(&mut *self.shared.receiving.lock().unwrap());
        pipelines.extend(self.shared.sound.lock().unwrap().take().map(|s| s.pipeline));
        pipelines.push(self.send.clone());
        pipelines.push(self.microphone.lock().unwrap().pipeline.clone());
        let _ = tokio::task::spawn_blocking(move || pipelines.into_iter().for_each(stop)).await;
    }
}

#[cfg(test)]
mod tests {
    // covers: calls.linux-native, calls.reconnect, calls.speaking, settings.network.relay-only
    use super::super::turn_lab::TurnLab;
    use super::*;

    #[test]
    fn the_answer_keeps_the_payload_types_of_the_offer() {
        let webkit = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\n\
                      m=video 9 UDP/TLS/RTP/SAVPF 96 106\r\na=rtpmap:96 H264/90000\r\na=rtpmap:106 VP8/90000\r\n";
        assert_eq!(offered_payload_types(webkit), (109, 106));
        assert_eq!(
            offered_payload_types("v=0\r\nm=audio 9 X 0\r\n"),
            (OPUS_PT, VP8_PT)
        );
    }

    #[test]
    fn the_description_carries_ssrcs_and_every_dialable_candidate_once_ipv4_hosts_first() {
        let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=candidate:9 1 UDP 1 1.2.3.4 5 typ host\r\n\
                   a=end-of-candidates\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ssrc:7 cname:x\r\n";
        let gathered = [
            "candidate:7 1 udp 2130706431 :: 42934 typ host".to_string(),
            "candidate:8 1 udp 2130706431 fd00::2 42935 typ host".to_string(),
            "candidate:1 1 UDP 2015363327 172.17.0.2 38415 typ host".to_string(),
            "candidate:9 1 udp 1 1.2.3.4 5 typ host".to_string(),
        ];
        let out = describe(sdp, &gathered, (11, 22));
        assert!(
            out.contains("a=mid:0\r\na=ssrc:11 cname:ghostly\r\nm=video"),
            "{out}"
        );
        assert!(
            !out.contains("a=ssrc:22"),
            "the video section had its own: {out}"
        );
        assert!(!out.contains("end-of-candidates"), "{out}");
        assert!(
            out.ends_with(
                "a=candidate:9 1 udp 1 1.2.3.4 5 typ host\r\na=candidate:1 1 udp 2015363327 172.17.0.2 38415 typ host\r\n\
                 a=candidate:8 1 udp 2130706431 fd00::2 42935 typ host\r\n"
            ),
            "{out}"
        );
    }

    fn turn_server(url: &str) -> IceServer {
        IceServer {
            urls: vec!["stun:stun.example.org".into(), url.into()],
            username: Some("ghost".into()),
            credential: Some("test-credential".into()),
        }
    }

    /// Hide my IP from contacts: the profile's TURN URLs alone under the relay policy, no STUN server; off, the
    /// built-in STUN server first as before.
    #[test]
    fn relay_only_asks_no_stun_server_and_keeps_to_the_relay() {
        let servers = [turn_server("turn:turn.example.org:3478")];
        let stun = || vec!["stun:192.0.2.1:19302".to_string()];
        let (relay, policy) = ice_configuration(stun(), &servers, true);
        assert_eq!(policy, RTCIceTransportPolicy::Relay);
        let urls: Vec<&str> = relay
            .iter()
            .flat_map(|s| s.urls.iter().map(String::as_str))
            .collect();
        assert_eq!(urls, ["turn:turn.example.org:3478"]);
        assert_eq!(relay[0].credential, "test-credential");
        let (all, policy) = ice_configuration(stun(), &servers, false);
        assert_eq!(policy, RTCIceTransportPolicy::All);
        assert_eq!(all[0].urls, stun());
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn a_relay_only_description_carries_relay_candidates_alone() {
        let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n\
                   a=candidate:1 1 udp 2130706431 192.168.1.5 40000 typ host\r\n\
                   a=candidate:2 1 udp 1694498815 203.0.113.7 40000 typ srflx\r\n\
                   a=candidate:3 1 udp 16777215 198.51.100.9 50000 typ relay\r\n";
        let out = relay_candidates_only(sdp);
        assert!(
            out.ends_with(
                "a=mid:0\r\na=candidate:3 1 udp 16777215 198.51.100.9 50000 typ relay\r\n"
            ),
            "{out}"
        );
    }

    /// With relay only and no TURN server, no call: never a direct path instead.
    #[tokio::test]
    async fn relay_only_without_a_turn_server_makes_no_call() {
        let stun_only = IceServer {
            urls: vec!["stun:stun.example.org".into()],
            ..Default::default()
        };
        let made = Call::new(
            OPUS_PT,
            VP8_PT,
            true,
            Devices::default(),
            &[stun_only],
            true,
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(made.err(), Some(NO_TURN.to_string()));
    }

    /// Relay only, against a local TURN server that never answers: the connection asks it for an allocation,
    /// gathers no host or server reflexive candidate (this machine's addresses), and there is no offer. Off, host
    /// candidates come within milliseconds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_relay_only_call_whose_turn_server_is_silent_makes_no_offer() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let silent = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        silent
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let url = format!("turn:{}?transport=udp", silent.local_addr().unwrap());
        let a = Call::new(
            OPUS_PT,
            VP8_PT,
            true,
            Devices::default(),
            &[turn_server(&url)],
            true,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let started = Instant::now();
        assert_eq!(a.offer(false).await.err(), Some(NO_RELAY.to_string()));
        assert!(started.elapsed() < gather::BOUNDS.first, "the relay wait");
        // An Allocate request (STUN method 0x003) reached the TURN server.
        let mut packet = [0u8; 1500];
        let (n, _) = silent.recv_from(&mut packet).expect("no Allocate request");
        assert!(n >= 20 && packet[..2] == [0x00, 0x03], "{:?}", &packet[..n]);
        let gathered = a.shared.gathering.gathered();
        assert!(gathered.is_empty(), "{gathered:?}");
        a.close().await;
    }

    /// Two relay-only calls through a TURN server on this machine ([`TurnLab`], or a real one such as coturn with
    /// `GHOSTLY_TURN_LAB=host:port`, user `ghost`, password `test-credential`): every candidate either side
    /// gathers and sends is `typ relay`, the pair ICE chooses is the relay's on both sides, and they hear each
    /// other through the server's channels.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_relay_only_calls_connect_through_the_turn_server() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let lab = match std::env::var("GHOSTLY_TURN_LAB") {
            Ok(_) => None,
            Err(_) => Some(TurnLab::start("ghost").await),
        };
        let address = match &lab {
            Some(lab) => lab.addr.to_string(),
            None => std::env::var("GHOSTLY_TURN_LAB").unwrap(),
        };
        let servers = [turn_server(&format!("turn:{address}?transport=udp"))];
        let call = || {
            Call::new(
                OPUS_PT,
                VP8_PT,
                true,
                Devices::default(),
                &servers,
                true,
                Arc::new(|_| {}),
            )
        };
        let a = call().await.unwrap();
        let offer = a.offer(false).await.unwrap();
        let b = call().await.unwrap();
        let answer = b.answer(&offer, false).await.unwrap();
        for sdp in [&offer, &answer] {
            let candidates: Vec<&str> = sdp
                .lines()
                .filter(|l| l.starts_with("a=candidate:"))
                .collect();
            assert!(!candidates.is_empty(), "{sdp}");
            assert!(
                candidates.iter().all(|c| c.contains(" typ relay")),
                "{candidates:?}"
            );
        }
        a.accept(&answer).await.unwrap();
        let stats = || {
            format!(
                "a {} b {}",
                serde_json::to_string(&a.stats()).unwrap(),
                serde_json::to_string(&b.stats()).unwrap()
            )
        };
        until(
            "both hear through the relay",
            30,
            || a.stats().audio_received > 20 && b.stats().audio_received > 20,
            stats,
        )
        .await;
        for side in [&a, &b] {
            let gathered = side.shared.gathering.gathered();
            assert!(
                gathered.iter().all(|c| c.contains(" typ relay")),
                "{gathered:?}"
            );
            let (local, remote) = side.selected_pair().await.expect("no selected pair");
            assert!(local.starts_with("relay "), "{local} to {remote}");
        }
        if let Some(lab) = &lab {
            let seen = |count: &std::sync::atomic::AtomicUsize| count.load(Ordering::Relaxed);
            // One per local socket ICE gathers on, each side.
            assert!(seen(&lab.seen.allocations) >= 2);
            assert!(seen(&lab.seen.channel_data_out) > 20, "ChannelData sent on");
            assert!(seen(&lab.seen.relayed_in) > 20, "relayed back");
        }
        a.close().await;
        b.close().await;
    }

    /// The `address port` of each candidate in a description.
    fn candidate_addresses(sdp: &str) -> Vec<String> {
        sdp.lines()
            .filter(|l| l.starts_with("a=candidate:"))
            .map(|l| l.split(' ').skip(4).take(2).collect::<Vec<_>>().join(" "))
            .collect()
    }

    /// An ICE restart through the TURN server: the restart offer and its answer carry this round's relay
    /// candidates alone. The relays of before are freed with their sockets, and the signal keeps the first two
    /// relay candidates only (`pickCallCandidates`): listed first, they were all a contact was told.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restart_offer_carries_this_rounds_candidates_alone() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let lab = TurnLab::start("ghost").await;
        let servers = [turn_server(&format!("turn:{}?transport=udp", lab.addr))];
        let call = || {
            Call::new(
                OPUS_PT,
                VP8_PT,
                true,
                Devices::default(),
                &servers,
                true,
                Arc::new(|_| {}),
            )
        };
        let a = call().await.unwrap();
        let offer = a.offer(false).await.unwrap();
        let b = call().await.unwrap();
        let answer = b.answer(&offer, false).await.unwrap();
        a.accept(&answer).await.unwrap();
        until(
            "both hear through the relay",
            30,
            || a.stats().audio_received > 20 && b.stats().audio_received > 20,
            String::new,
        )
        .await;

        let restart = a.offer(true).await.unwrap();
        let before = candidate_addresses(&offer);
        let stale: Vec<String> = candidate_addresses(&restart)
            .into_iter()
            .filter(|c| before.contains(c))
            .collect();
        assert!(stale.is_empty(), "{stale:?} in {restart}");
        assert!(restart.contains(" typ relay"), "{restart}");
        let restarted = b.answer(&restart, true).await.unwrap();
        let before = candidate_addresses(&answer);
        assert!(
            candidate_addresses(&restarted)
                .iter()
                .all(|c| !before.contains(c)),
            "{restarted}"
        );
        a.accept(&restarted).await.unwrap();
        let (a_heard, b_heard) = (a.stats().audio_received, b.stats().audio_received);
        until(
            "both hear after the restart",
            30,
            || a.stats().audio_received > a_heard + 50 && b.stats().audio_received > b_heard + 50,
            String::new,
        )
        .await;
        a.close().await;
        b.close().await;
    }

    #[test]
    fn the_meter_reads_loudness_as_the_pages_meter_does() {
        assert_eq!(meter_level(f64::NEG_INFINITY), 0.0);
        assert_eq!(meter_level(f64::NAN), 0.0);
        // A sine at 0.2 has an RMS of 0.141 (-17 dB): 0.57 on the meter, as `voiceLevel` gives its samples.
        let sine = 20.0 * (0.2 / 2f64.sqrt()).log10();
        assert!(
            (meter_level(sine) - 0.566).abs() < 0.001,
            "{}",
            meter_level(sine)
        );
        assert_eq!(meter_level(0.0), 1.0);
        assert!(meter_level(-60.0) < 0.005);
    }

    /// Settings' meter says a reading in hundredths, as the page draws it, and only when that changes: a silent
    /// microphone is said once, not 12 times a second. Out of sight, none at all (12 evals a second for a meter
    /// nobody sees); back in sight the next reading is said, even one the same as the last said.
    #[test]
    fn the_meter_says_a_change_while_in_sight_and_nothing_out_of_it() {
        static HIDDEN: AtomicBool = AtomicBool::new(false);
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let into = told.clone();
        let heard = meter_says(
            Arc::new(move |bytes| into.lock().unwrap().push(String::from_utf8(bytes).unwrap())),
            &HIDDEN,
        );
        for level in [0.0, 0.0, 0.0, 0.5653, 0.5665, 0.5643] {
            heard(level);
        }
        HIDDEN.store(true, Ordering::Relaxed);
        for level in [0.3, 0.5643, 0.0] {
            heard(level);
        }
        HIDDEN.store(false, Ordering::Relaxed);
        heard(0.0);
        heard(0.0);
        assert_eq!(
            *told.lock().unwrap(),
            [
                r#"{"level":0.0}"#,
                r#"{"level":0.57}"#,
                r#"{"level":0.56}"#,
                r#"{"level":0.0}"#
            ]
        );
    }

    /// Settings' meter on the test tone, then on a microphone that is not there (the default instead), and the
    /// speakers' test, which ends by itself. Skipped where the GStreamer plugins are missing.
    #[test]
    fn the_meter_hears_the_microphone_and_the_speakers_test_ends() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let heard = Arc::new(Mutex::new(Vec::<f64>::new()));
        let meter = |wanted: Option<&str>| {
            heard.lock().unwrap().clear();
            let into = heard.clone();
            let meter = Meter::open(
                true,
                wanted,
                Arc::new(move |bytes: Vec<u8>| {
                    let reading: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    into.lock()
                        .unwrap()
                        .push(reading["level"].as_f64().unwrap());
                }),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while heard.lock().unwrap().len() < 5 {
                assert!(Instant::now() < deadline, "no readings");
                std::thread::sleep(Duration::from_millis(50));
            }
            let device = meter.device.clone();
            drop(meter);
            let heard = heard.lock().unwrap();
            (device, heard.iter().copied().fold(0.0, f64::max))
        };
        let (device, loudest) = meter(None);
        assert_eq!(device, None);
        assert!((loudest - 0.566).abs() < 0.05, "the tone read {loudest}");
        let (device, loudest) = meter(Some("No such microphone"));
        assert_eq!(device, None);
        assert!(loudest > 0.5, "the default read {loudest}");

        let started = Instant::now();
        assert_eq!(test_speaker(true, Some("No such speaker")), Ok(None));
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "the tone lasted {:?}",
            started.elapsed()
        );
    }

    /// A device that opens and then cannot agree on a format (an IPU6 camera through a bare `v4l2src`) or fails a
    /// moment later: GStreamer says so on the bus, after `set_state` said yes. That start failed, so the default
    /// is tried; a device whose pictures come starts at once.
    #[test]
    fn a_device_that_fails_once_playing_did_not_start() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let not_negotiated = launch(
            "videotestsrc is-live=true ! capsfilter name=device \
             ! appsink name=out caps=video/x-raw,format=I420 sync=false async=false",
        )
        .unwrap();
        // Set after linking, as a device's own formats are found only once it opens.
        element::<gst::Element>(&not_negotiated, "device")
            .unwrap()
            .set_property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "RGB")
                    .build(),
            );
        let failed = start_capturing(&not_negotiated, "The camera");
        assert!(
            failed
                .as_ref()
                .is_err_and(|e| e.starts_with("The camera: ")),
            "{failed:?}"
        );
        assert_eq!(not_negotiated.current_state(), gst::State::Null);

        let working = launch(
            "videotestsrc is-live=true ! video/x-raw,format=I420 ! queue name=device \
             ! appsink name=out sync=false async=false",
        )
        .unwrap();
        let started = Instant::now();
        assert_eq!(start_capturing(&working, "The camera"), Ok(()));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(working.current_state(), gst::State::Playing);
        stop(working);
    }

    /// A peer's pictures faster than the page is shown them (a browser sends 30 a second): the ones left out are
    /// left out as they are decoded, so none is made a JPEG for nothing. 60 pictures as fast as they come stand
    /// for the peer's.
    #[test]
    fn a_picture_the_page_is_not_shown_is_never_made_a_jpeg() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let pipeline = launch(&format!(
            "videotestsrc num-buffers=60 ! video/x-raw,format=I420,width=640,height=480,framerate=30/1 \
             ! identity name=decoder ! {}",
            shown()
        ))
        .unwrap();
        let (decoded, encoded, pictures) = (
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(0)),
        );
        let count = |name: &str, pad: &str, into: &Arc<AtomicU64>| {
            let into = into.clone();
            element::<gst::Element>(&pipeline, name)
                .unwrap()
                .static_pad(pad)
                .unwrap()
                .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                    into.fetch_add(1, Ordering::Relaxed);
                    gst::PadProbeReturn::Ok
                });
        };
        // Before `show` adds anything of its own: every picture the decoder gives is counted.
        count("decoder", "src", &decoded);
        count("jpeg", "sink", &encoded);
        let seen = pictures.clone();
        show(
            &pipeline,
            Arc::new(move |jpeg: Vec<u8>| {
                assert!(jpeg.starts_with(&[0xff, 0xd8]));
                seen.fetch_add(1, Ordering::Relaxed);
            }),
        )
        .unwrap();
        let started = Instant::now();
        start(&pipeline, "The picture").unwrap();
        let ended = pipeline.bus().unwrap().timed_pop_filtered(
            gst::ClockTime::from_seconds(60),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        let took = started.elapsed();
        stop(pipeline);
        assert!(
            matches!(
                ended.as_ref().map(|m| m.view()),
                Some(gst::MessageView::Eos(_))
            ),
            "{ended:?}"
        );
        let (decoded, encoded, pictures) = (
            decoded.load(Ordering::Relaxed),
            encoded.load(Ordering::Relaxed),
            pictures.load(Ordering::Relaxed),
        );
        assert_eq!(decoded, 60);
        // The first one, then one for each fifteenth of a second gone by (the last may be a hair early).
        let most = 1 + (took + SHOWN_EARLY).as_millis() as u64 * u64::from(SHOWN_FPS) / 1000;
        assert!(
            (1..=most).contains(&pictures),
            "{pictures} pictures shown in {took:?}"
        );
        assert_eq!(
            encoded, pictures,
            "{encoded} JPEGs made for {pictures} shown"
        );
    }

    /// What a peer's VP8 pictures of that size, as RTP, make the call's video receiver decode.
    fn decoded_of(width: u32, height: u32, pictures: u32) -> u64 {
        let (shared, _) = telling();
        let (keyframes, _) = mpsc::unbounded_channel();
        let (rtp, receiving, _) =
            receiver(&shared, true, VP8_PT, Arc::default(), keyframes).unwrap();
        let peer = launch(&format!(
            "videotestsrc num-buffers={pictures} ! video/x-raw,format=I420,width={width},height={height},framerate=15/1 \
             ! vp8enc deadline=1 cpu-used=16 keyframe-max-dist=5 ! rtpvp8pay pt={VP8_PT} mtu=1200 \
             ! appsink name=out sync=false"
        ))
        .unwrap();
        let out: gst_app::AppSink = element(&peer, "out").unwrap();
        start(&peer, "The peer").unwrap();
        while let Ok(sample) = out.pull_sample() {
            rtp.push_buffer(sample.buffer_owned().unwrap()).unwrap();
        }
        stop(peer);
        // Past the jitter buffer's 100 ms, and a picture's decoding.
        let end = Instant::now() + Duration::from_secs(3);
        while shared.counts.video_received.load(Ordering::Relaxed) < u64::from(pictures)
            && Instant::now() < end
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop(receiving);
        shared.counts.video_received.load(Ordering::Relaxed)
    }

    /// A peer's pictures larger than any screen (VP8 allows 16383×16383: a third of a second of a core and 2.4 GiB
    /// each) are never decoded; a camera's are.
    #[test]
    fn a_peers_picture_larger_than_any_screen_is_never_decoded() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        assert_eq!(decoded_of(7696, 4320, 3), 0);
        assert!(decoded_of(640, 480, 10) > 0);
    }

    /// The page out of sight: a peer's pictures are made JPEGs until one has gone to the page, then none, until
    /// it is back in sight. 2 s of a live peer at 30 a second, out of sight for the first half and more.
    #[test]
    fn out_of_sight_the_peers_pictures_stop_after_the_first() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        static HIDDEN: AtomicBool = AtomicBool::new(true);
        let pipeline = launch(&format!(
            "videotestsrc is-live=true num-buffers=60 ! video/x-raw,format=I420,width=640,height=480,framerate=30/1 \
             ! identity name=decoder ! {}",
            shown()
        ))
        .unwrap();
        let (encoded, pictures) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let into = encoded.clone();
        element::<gst::Element>(&pipeline, "jpeg")
            .unwrap()
            .static_pad("sink")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                into.fetch_add(1, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });
        let seen = pictures.clone();
        show_while(
            &pipeline,
            Arc::new(move |_| {
                seen.fetch_add(1, Ordering::Relaxed);
            }),
            &HIDDEN,
        )
        .unwrap();
        start(&pipeline, "The picture").unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while pictures.load(Ordering::Relaxed) == 0 {
            assert!(Instant::now() < end, "no picture");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Long enough for 10 more at 15 a second.
        std::thread::sleep(Duration::from_millis(700));
        let (made_hidden, shown_hidden) = (
            encoded.load(Ordering::Relaxed),
            pictures.load(Ordering::Relaxed),
        );
        HIDDEN.store(false, Ordering::Relaxed);
        let ended = pipeline.bus().unwrap().timed_pop_filtered(
            gst::ClockTime::from_seconds(60),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        stop(pipeline);
        assert!(
            matches!(
                ended.as_ref().map(|m| m.view()),
                Some(gst::MessageView::Eos(_))
            ),
            "{ended:?}"
        );
        assert_eq!(
            (made_hidden, shown_hidden),
            (1, 1),
            "JPEGs made and shown out of sight"
        );
        let shown = pictures.load(Ordering::Relaxed);
        assert!(shown > 1, "{shown} pictures shown once back in sight");
        assert_eq!(encoded.load(Ordering::Relaxed), shown);
    }

    /// The page out of sight: no level goes to it (12 a second each side while someone speaks, an eval each, for a
    /// ring nobody sees), and back in sight the next reading is said, even one the same as the last said.
    #[test]
    fn out_of_sight_no_level_is_said_and_the_next_is_once_back() {
        static HIDDEN: AtomicBool = AtomicBool::new(false);
        let (shared, told) = telling();
        shared.levels.store(true, Ordering::Relaxed);
        let heard = shared.hears_while("peer", &HIDDEN);
        heard(0.4);
        heard(0.4);
        HIDDEN.store(true, Ordering::Relaxed);
        for level in [0.5, 0.6, 0.0, 0.4] {
            heard(level);
        }
        HIDDEN.store(false, Ordering::Relaxed);
        heard(0.4);
        heard(0.4);
        assert_eq!(
            *told.lock().unwrap(),
            [r#"{"levels":{"peer":0.4}}"#, r#"{"levels":{"peer":0.4}}"#]
        );
    }

    /// A call's `Shared`, and what it tells its page (as text).
    fn telling() -> (Arc<Shared>, Arc<Mutex<Vec<String>>>) {
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let into = told.clone();
        let shared = Arc::new(Shared {
            fake: true,
            events: Arc::new(move |bytes| {
                // Pictures (JPEGs) too, as whatever text they read as.
                into.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&bytes).into_owned());
            }),
            counts: Counts::default(),
            ice: Mutex::new("new".into()),
            told_connected: AtomicBool::new(false),
            gathering: Gathering::default(),
            receiving: Mutex::default(),
            speaker: Mutex::default(),
            sound: Mutex::default(),
            pictures: AtomicBool::new(true),
            levels: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        });
        (shared, told)
    }

    /// No level goes to a page that draws no one speaking (a video call: 20 evals a second for nothing), until it
    /// asks; then the next reading is said, even one the same as the last said; and none once it lets them go.
    #[test]
    fn no_level_is_said_until_the_page_asks_and_none_once_it_stops() {
        static SHOWN: AtomicBool = AtomicBool::new(false);
        let (shared, told) = telling();
        let heard = shared.hears_while("mic", &SHOWN);
        for level in [0.4, 0.5] {
            heard(level);
        }
        shared.levels.store(true, Ordering::Relaxed);
        heard(0.5);
        heard(0.5);
        shared.levels.store(false, Ordering::Relaxed);
        for level in [0.3, 0.5] {
            heard(level);
        }
        shared.levels.store(true, Ordering::Relaxed);
        heard(0.5);
        assert_eq!(
            *told.lock().unwrap(),
            [r#"{"levels":{"mic":0.5}}"#, r#"{"levels":{"mic":0.5}}"#]
        );
    }

    /// The page out of sight: a camera's preview is made a JPEG until one has gone to the page, then none, until it
    /// is back in sight; the call's own frames (`out`) are not the page's and go on.
    #[test]
    fn out_of_sight_the_camera_preview_stops_after_the_first() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        static HIDDEN: AtomicBool = AtomicBool::new(true);
        let previews = Arc::new(AtomicU64::new(0));
        let seen = previews.clone();
        let camera = Camera::open_while(
            true,
            None,
            Arc::new(move |bytes: Vec<u8>| {
                if bytes.starts_with(&[0xff, 0xd8]) {
                    seen.fetch_add(1, Ordering::Relaxed);
                }
            }),
            &HIDDEN,
        )
        .unwrap();
        let until = |count: u64| {
            let end = Instant::now() + Duration::from_secs(10);
            while previews.load(Ordering::Relaxed) < count {
                assert!(
                    Instant::now() < end,
                    "{} previews",
                    previews.load(Ordering::Relaxed)
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        until(1);
        // Long enough for 10 more at 15 a second.
        std::thread::sleep(Duration::from_millis(700));
        let hidden = previews.load(Ordering::Relaxed);
        HIDDEN.store(false, Ordering::Relaxed);
        until(3);
        drop(camera);
        assert_eq!(hidden, 1, "previews out of sight");
    }

    /// How many of 4 s of pictures `gap_us` apart the page is shown, each coming up to `jitter_us` early or late,
    /// and the longest and shortest time between two of them (ms).
    fn shown_of(gap_us: u64, jitter_us: u64) -> (usize, u128, u128) {
        let started = Instant::now();
        let mut next = None;
        let mut passed = Vec::new();
        for n in 0..4_000_000 / gap_us {
            // Early, on time, late, on time: the same every run.
            let off = [0, jitter_us, 2 * jitter_us, jitter_us][n as usize % 4];
            let now = started + Duration::from_micros(n * gap_us + off);
            if due(&mut next, now) {
                passed.push(now);
            }
        }
        let gaps = passed
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).as_millis());
        (
            passed.len(),
            gaps.clone().max().unwrap(),
            gaps.min().unwrap(),
        )
    }

    #[test]
    fn the_page_is_shown_fifteen_pictures_a_second_evenly() {
        // 30 a second: every second one, whether they come on the dot or 5 ms early and late.
        for jitter in [0, 5_000] {
            let (shown, longest, shortest) = shown_of(33_333, jitter);
            assert_eq!(shown, 60, "at 30 a second, {jitter} us of jitter");
            assert!(
                longest <= 77 && shortest >= 56,
                "gaps of {shortest} to {longest} ms"
            );
        }
        // 60 a second: every fourth one.
        let (shown, longest, shortest) = shown_of(16_667, 3_000);
        assert_eq!(shown, 60);
        assert!(
            longest <= 73 && shortest >= 60,
            "gaps of {shortest} to {longest} ms"
        );
        // 15 a second or fewer: all of them.
        assert_eq!(shown_of(66_666, 5_000).0, 60);
        assert_eq!(shown_of(100_000, 5_000).0, 40);
        // 25 a second: 15, no more.
        assert_eq!(shown_of(40_000, 0).0, 60);

        // After a pause the count starts again: the pictures that follow are not let through to catch up.
        let every = Duration::from_secs(1) / SHOWN_FPS;
        let started = Instant::now();
        let mut next = None;
        assert!(due(&mut next, started));
        let later = started + Duration::from_secs(3);
        assert!(due(&mut next, later));
        assert!(!due(&mut next, later + Duration::from_millis(1)));
        assert!(!due(&mut next, later + every / 2));
        assert!(due(&mut next, later + every));
    }

    /// A peer at 30 pictures a second, as they come in a call (a live source, 4 s of it): the page is shown every
    /// second one, 15 a second, not the 12 that "a fifteenth of a second since the last one came" gave.
    #[test]
    fn a_peer_at_thirty_pictures_a_second_is_shown_fifteen() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let pipeline = launch(&format!(
            "videotestsrc is-live=true num-buffers=120 \
             ! video/x-raw,format=I420,width=320,height=240,framerate=30/1 ! identity name=decoder ! {}",
            shown()
        ))
        .unwrap();
        // When each picture the page is shown left the decoder.
        let passed = Arc::new(Mutex::new(Vec::<Instant>::new()));
        show(&pipeline, Arc::new(|_| {})).unwrap();
        let into = passed.clone();
        element::<gst::Element>(&pipeline, "jpeg")
            .unwrap()
            .static_pad("sink")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                into.lock().unwrap().push(Instant::now());
                gst::PadProbeReturn::Ok
            });
        start(&pipeline, "The picture").unwrap();
        let ended = pipeline.bus().unwrap().timed_pop_filtered(
            gst::ClockTime::from_seconds(60),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        stop(pipeline);
        assert!(
            matches!(
                ended.as_ref().map(|m| m.view()),
                Some(gst::MessageView::Eos(_))
            ),
            "{ended:?}"
        );
        let passed = passed.lock().unwrap();
        let took = *passed.last().unwrap() - passed[0];
        // Against the time they took, not a fixed number: a loaded machine gives the source's pictures late.
        let gaps = passed.len() as u128 - 1;
        assert!(
            gaps * 1000 >= 14 * took.as_millis(),
            "{} pictures shown in {took:?}",
            passed.len()
        );
        assert!(
            gaps * 1000 <= 15 * (took + SHOWN_EARLY).as_millis() + 999,
            "{} pictures shown in {took:?}",
            passed.len()
        );
    }

    /// Waits until `done` holds, or says what it saw.
    async fn until(what: &str, seconds: u64, done: impl Fn() -> bool, saw: impl Fn() -> String) {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while !done() {
            assert!(Instant::now() < deadline, "{what}: {}", saw());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Two calls in this process, test tone and test picture, the second answering the first's offer: both
    /// hear, the answerer sees, a picture turned on halfway reaches the offerer. Skipped where the GStreamer
    /// plugins are missing (CI installs them).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_calls_exchange_sound_and_pictures() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let frames = Arc::new(AtomicU64::new(0));
        let seen = frames.clone();
        let (a_levels, b_levels) = (Levels::default(), Levels::default());
        let (a_told, b_told) = (a_levels.clone(), b_levels.clone());
        let a = Call::new(
            OPUS_PT,
            VP8_PT,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(move |bytes: Vec<u8>| a_told.heard(&bytes)),
        )
        .await
        .unwrap();
        let a_camera = Camera::open(true, None, Arc::new(|_| {})).unwrap();
        assert_eq!(a_camera.device, None);
        a_camera.attach(Some(a.video_input()));
        let offer = a.offer(false).await.unwrap();
        assert!(
            offer.contains("a=candidate:") && offer.contains(" udp "),
            "{offer}"
        );
        let (opus, vp8) = offered_payload_types(&offer);
        let b = Call::new(
            opus,
            vp8,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(move |bytes: Vec<u8>| {
                if bytes.starts_with(&[0xff, 0xd8]) {
                    seen.fetch_add(1, Ordering::Relaxed);
                }
                b_told.heard(&bytes);
            }),
        )
        .await
        .unwrap();
        let answer = b.answer(&offer, false).await.unwrap();
        a.accept(&answer).await.unwrap();
        // Both pages draw who is speaking (a voice call's window).
        a.set_levels(true);
        b.set_levels(true);
        let stats = || {
            format!(
                "a {} b {}",
                serde_json::to_string(&a.stats()).unwrap(),
                serde_json::to_string(&b.stats()).unwrap()
            )
        };
        until(
            "both hear",
            30,
            || a.stats().audio_received > 20 && b.stats().audio_received > 20,
            stats,
        )
        .await;
        // Who is speaking: each page is told how loud its microphone is and how loud the peer's sound, the test
        // tone both ways (0.57 on the meter, about that once through Opus).
        let levels = || format!("a {} b {}", a_levels.said(), b_levels.said());
        let tone = |level: f64| (level - 0.566).abs() < 0.12;
        until(
            "both pages are told the levels",
            30,
            || {
                [&a_levels, &b_levels]
                    .iter()
                    .all(|told| tone(told.of("mic")) && tone(told.of("peer")))
            },
            levels,
        )
        .await;
        until(
            "the answerer sees",
            30,
            || b.stats().video_received > 5 && frames.load(Ordering::Relaxed) > 3,
            stats,
        )
        .await;
        assert!(
            matches!(b.stats().ice.as_str(), "connected" | "completed"),
            "{}",
            stats()
        );
        // What the connection counted agrees: the offerer's pictures left as RTP and arrived as RTP.
        let (sent, received) = (a.transport().await, b.transport().await);
        assert!(
            sent["sent"]["video"]["packets"].as_u64() > Some(0)
                && received["received"]["video"]["packets"].as_u64() > Some(0)
                && received["received"]["video"]["ssrc"] == sent["sent"]["video"]["ssrc"],
            "{sent} {received}"
        );
        // The answerer's camera comes on halfway, as it does in a voice call: no new offer.
        assert_eq!(a.stats().video_received, 0, "{}", stats());
        let b_camera = Camera::open(true, Some("Test bars"), Arc::new(|_| {})).unwrap();
        assert_eq!(b_camera.device.as_deref(), Some("Test bars"));
        b_camera.attach(Some(b.video_input()));
        until(
            "the offerer sees",
            30,
            || a.stats().video_received > 5,
            stats,
        )
        .await;

        // The microphone and the speaker change mid-call: to devices that are not there, so the defaults again,
        // relaunched. The sound goes on both ways, and a muted microphone stays muted.
        a.set_muted(true);
        // Muted, the microphone reads silence, and so does the peer of it; the other way goes on.
        until(
            "a muted microphone is silence on both pages",
            30,
            || a_levels.of("mic") == 0.0 && b_levels.of("peer") < 0.02,
            levels,
        )
        .await;
        assert!(tone(b_levels.of("mic")), "{}", levels());
        let (heard, sent) = (b.stats().audio_received, a.stats().audio_sent);
        let used = tokio::task::block_in_place(|| a.set_microphone(Some("No such microphone")));
        assert_eq!(used, Ok(None));
        assert!(a.stats().muted, "{}", stats());
        a.set_muted(false);
        until(
            "the new microphone is sent",
            30,
            || a.stats().audio_sent > sent + 20,
            stats,
        )
        .await;
        until(
            "and heard",
            30,
            || b.stats().audio_received > heard + 20,
            stats,
        )
        .await;
        until(
            "the new microphone's level is told",
            30,
            || tone(a_levels.of("mic")) && tone(b_levels.of("peer")),
            levels,
        )
        .await;
        let heard = a.stats().audio_received;
        tokio::task::block_in_place(|| a.set_speaker(Some("No such speaker".into()))).unwrap();
        until(
            "the sound plays on",
            30,
            || a.stats().audio_received > heard + 20,
            stats,
        )
        .await;
        assert_eq!(a.stats().speaker, None, "{}", stats());
        a.close().await;
        b.close().await;
    }

    /// An answer with its video section closed, as a peer that takes no picture (`vr: 0`) has it rebuilt.
    fn closed_video(sdp: &str) -> String {
        let mut video = false;
        sdp.split("\r\n")
            .map(|line| {
                if line.starts_with("m=") {
                    video = line.starts_with("m=video");
                }
                if video && line == "a=sendrecv" {
                    "a=inactive"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\r\n")
    }

    /// A peer that takes no picture (`vr: 0`, a bot) answers the video section closed: the camera that is on
    /// is neither encoded nor sent, and the sound goes on both ways.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_closed_video_section_sends_no_picture() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let a = Call::new(
            OPUS_PT,
            VP8_PT,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let camera = Camera::open(true, None, Arc::new(|_| {})).unwrap();
        camera.attach(Some(a.video_input()));
        // Each picture the encoder makes.
        let encoded = Arc::new(AtomicU64::new(0));
        let into = encoded.clone();
        element::<gst::Element>(&a.send, "vp8")
            .unwrap()
            .static_pad("sink")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                into.fetch_add(1, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });
        let offer = a.offer(false).await.unwrap();
        let (opus, vp8) = offered_payload_types(&offer);
        let b = Call::new(
            opus,
            vp8,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let answer = closed_video(&b.answer(&offer, false).await.unwrap());
        assert!(answer.contains("a=inactive"), "{answer}");
        let stats = || {
            format!(
                "a {} b {} encoded {}",
                serde_json::to_string(&a.stats()).unwrap(),
                serde_json::to_string(&b.stats()).unwrap(),
                encoded.load(Ordering::Relaxed)
            )
        };
        // Until the answer, the camera is encoded as in any call.
        until(
            "the camera is encoded",
            30,
            || encoded.load(Ordering::Relaxed) > 3,
            stats,
        )
        .await;
        a.accept(&answer).await.unwrap();
        until(
            "both hear",
            30,
            || a.stats().audio_received > 20 && b.stats().audio_received > 20,
            stats,
        )
        .await;
        // Before the answer webrtc-rs takes the pictures written (counted as sent) and has nowhere to send them.
        let (since, sent) = (encoded.load(Ordering::Relaxed), a.stats().video_sent);
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(encoded.load(Ordering::Relaxed), since, "{}", stats());
        assert_eq!(a.stats().video_sent, sent, "{}", stats());
        let report = a.transport().await;
        assert_eq!(
            report["sent"]["video"]["packets"].as_u64().unwrap_or(0),
            0,
            "{report}"
        );
        assert_eq!(b.stats().video_received, 0, "{}", stats());
        a.close().await;
        b.close().await;
    }

    /// Mute pressed while another microphone opens: it does not wait for the open (the window's thread calls it,
    /// and the window froze until GStreamer had opened the device), and the microphone switched in is muted all
    /// the same, though it opened before the press.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn mute_does_not_wait_for_a_microphone_opening() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let a = Arc::new(
            Call::new(
                OPUS_PT,
                VP8_PT,
                true,
                Devices::default(),
                &[],
                false,
                Arc::new(|_| {}),
            )
            .await
            .unwrap(),
        );
        let muted = {
            // As `set_microphone` has it while GStreamer opens the device: the lock held, the new one opened
            // unmuted.
            let mut opening = a.microphone.lock().unwrap();
            let next = a.voice.open(None).unwrap();
            let (pressed, done) = std::sync::mpsc::channel();
            let pressing = a.clone();
            std::thread::spawn(move || {
                pressing.set_muted(true);
                let _ = pressed.send(());
            });
            if done.recv_timeout(Duration::from_secs(5)).is_err() {
                drop(opening);
                panic!("mute waited for the microphone opening");
            }
            a.switch_to(&mut opening, next);
            opening.volume.property::<bool>("mute")
        };
        assert!(muted, "the microphone switched in is sent unmuted");
        assert!(a.stats().muted);
        a.close().await;
    }

    /// The device of a playing pipeline fails, as one unplugged or with a bus error does: its source posts an
    /// error, twice.
    fn fail(pipeline: &gst::Pipeline) {
        let source = pipeline.iterate_sources().next().unwrap().unwrap();
        for _ in 0..2 {
            let error =
                gst::message::Error::builder(gst::ResourceError::Read, "The device went away")
                    .src(&source)
                    .build();
            source.post_message(error).unwrap();
        }
    }

    /// What a page was told apart from pictures and levels (`{"ended":"camera"}`), in order.
    #[derive(Clone, Default)]
    struct Told(Arc<Mutex<Vec<serde_json::Value>>>);

    impl Told {
        fn heard(&self, bytes: &[u8]) {
            if let Ok(said) = serde_json::from_slice::<serde_json::Value>(bytes) {
                if said.get("ended").is_some() {
                    self.0.lock().unwrap().push(said);
                }
            }
        }

        fn said(&self) -> Vec<serde_json::Value> {
            self.0.lock().unwrap().clone()
        }
    }

    /// A camera that fails once it gives pictures (unplugged, a bus error after it ran) tells the page, once, on its
    /// frames' channel: the page ends its track and goes on with the default.
    #[test]
    fn a_camera_that_fails_mid_call_tells_the_page() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let (told, pictures) = (Told::default(), Arc::new(AtomicU64::new(0)));
        let (into, seen) = (told.clone(), pictures.clone());
        let camera = Camera::open(
            true,
            Some("Test bars"),
            Arc::new(move |bytes: Vec<u8>| {
                if bytes.starts_with(&[0xff, 0xd8]) {
                    seen.fetch_add(1, Ordering::Relaxed);
                } else {
                    into.heard(&bytes);
                }
            }),
        )
        .unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while pictures.load(Ordering::Relaxed) < 3 {
            assert!(Instant::now() < end, "no pictures");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(told.said(), Vec::<serde_json::Value>::new());
        fail(&camera.pipeline);
        assert_eq!(told.said(), [serde_json::json!({ "ended": "camera" })]);
        drop(camera);
    }

    /// The microphone a call sends fails mid-call: the call's page is told, once. The one it switches to is a
    /// microphone of its own, told in turn when it fails.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_microphone_that_fails_mid_call_tells_the_page() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let (told, levels) = (Told::default(), Levels::default());
        let (into, heard) = (told.clone(), levels.clone());
        let a = Call::new(
            OPUS_PT,
            VP8_PT,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(move |bytes: Vec<u8>| {
                into.heard(&bytes);
                heard.heard(&bytes);
            }),
        )
        .await
        .unwrap();
        a.set_levels(true);
        until(
            "the microphone runs",
            10,
            || levels.of("mic") > 0.0,
            || levels.said(),
        )
        .await;
        let ended = serde_json::json!({ "ended": "microphone" });
        fail(&a.microphone.lock().unwrap().pipeline);
        assert_eq!(told.said(), std::slice::from_ref(&ended));

        let used = tokio::task::block_in_place(|| a.set_microphone(None));
        assert_eq!(used, Ok(None));
        assert_eq!(
            told.said(),
            std::slice::from_ref(&ended),
            "the new one has not failed"
        );
        fail(&a.microphone.lock().unwrap().pipeline);
        assert_eq!(told.said(), [ended.clone(), ended]);
        a.close().await;
    }

    #[test]
    fn pictures_go_where_the_peer_takes_them() {
        let section = |direction: &str| {
            format!("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n{direction}\r\n")
        };
        assert!(takes_pictures(&section("a=sendrecv")));
        assert!(takes_pictures(&section("a=recvonly")));
        assert!(!takes_pictures(&section("a=inactive")));
        assert!(!takes_pictures(&section("a=sendonly")));
        // The audio section's direction says nothing of the picture.
        assert!(!takes_pictures(
            "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\n"
        ));
        assert!(takes_pictures(
            "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n"
        ));
    }

    /// The offerer is the DTLS client, so its handshake starts on the pair its own ICE picked: a peer that was
    /// the client sent its first flight on the first pair that worked for it, webrtc-rs dropped it until it had
    /// nominated its own, and the call connected a second later (the peer's DTLS resend). The answer to such an
    /// offer is passive, and an answer that still says active (a Desktop before this, whose DTLS is the server
    /// all the same) is read as passive: both connect.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_offerer_is_the_dtls_client_whoever_answers() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let setup = |sdp: &str| {
            sdp.lines()
                .filter_map(|l| l.trim_end().strip_prefix("a=setup:"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        let call = || {
            Call::new(
                OPUS_PT,
                VP8_PT,
                true,
                Devices::default(),
                &[],
                false,
                Arc::new(|_| {}),
            )
        };
        for released in [false, true] {
            let a = call().await.unwrap();
            let offer = a.offer(false).await.unwrap();
            assert_eq!(setup(&offer), ["active", "active"], "{offer}");
            let b = call().await.unwrap();
            let answer = if released {
                // As a Desktop before this answers: webrtc-rs's own answer, active whatever the offer said.
                let offer = RTCSessionDescription::offer(offer.clone()).unwrap();
                b.pc.set_remote_description(offer).await.unwrap();
                let answer = b.pc.create_answer(None).await.unwrap();
                b.local(answer, false).await.unwrap()
            } else {
                b.answer(&offer, false).await.unwrap()
            };
            let said = if released { "active" } else { "passive" };
            assert_eq!(setup(&answer), [said, said], "{answer}");
            a.accept(&answer).await.unwrap();
            let stats = || {
                format!(
                    "released {released}: a {} b {}",
                    serde_json::to_string(&a.stats()).unwrap(),
                    serde_json::to_string(&b.stats()).unwrap()
                )
            };
            until(
                "both hear",
                30,
                || a.stats().audio_received > 20 && b.stats().audio_received > 20,
                stats,
            )
            .await;
            a.close().await;
            b.close().await;
        }
    }

    /// The last level a call told its page for each side (`{"levels":{"mic":0.4}}`).
    #[derive(Clone, Default)]
    struct Levels(Arc<Mutex<std::collections::BTreeMap<String, f64>>>);

    impl Levels {
        fn heard(&self, bytes: &[u8]) {
            let Ok(said) = serde_json::from_slice::<serde_json::Value>(bytes) else {
                return;
            };
            for (side, level) in said["levels"].as_object().into_iter().flatten() {
                self.0
                    .lock()
                    .unwrap()
                    .insert(side.clone(), level.as_f64().unwrap());
            }
        }

        /// A side's level, -1 when none was told yet.
        fn of(&self, side: &str) -> f64 {
            self.0.lock().unwrap().get(side).copied().unwrap_or(-1.0)
        }

        fn said(&self) -> String {
            format!("{:?}", self.0.lock().unwrap())
        }
    }

    /// The ICE user name of a description.
    fn ufrag(sdp: &str) -> String {
        sdp.lines()
            .find_map(|l| l.trim_end().strip_prefix("a=ice-ufrag:"))
            .unwrap_or_default()
            .to_string()
    }

    /// A call that is up restarts ICE on the same connections (WISP 601, "Reconnecting"): the offerer's restart
    /// offer and the answerer's answer carry new credentials and candidates gathered anew, on sockets bound
    /// again, and the sound goes on both ways. Then once more, as a call does when its path is lost again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_call_restarts_ice_and_goes_on() {
        if let Some(missing) = missing() {
            eprintln!("skipped: {missing}");
            return;
        }
        let a = Call::new(
            OPUS_PT,
            VP8_PT,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let offer = a.offer(false).await.unwrap();
        let (opus, vp8) = offered_payload_types(&offer);
        let b = Call::new(
            opus,
            vp8,
            true,
            Devices::default(),
            &[],
            false,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let answer = b.answer(&offer, false).await.unwrap();
        a.accept(&answer).await.unwrap();
        let stats = || {
            format!(
                "a {} b {}",
                serde_json::to_string(&a.stats()).unwrap(),
                serde_json::to_string(&b.stats()).unwrap()
            )
        };
        until(
            "both hear",
            30,
            || a.stats().audio_received > 20 && b.stats().audio_received > 20,
            stats,
        )
        .await;

        let (mut offered, mut answered) = (ufrag(&offer), ufrag(&answer));
        for round in 1..=2 {
            let offer = a.offer(true).await.unwrap();
            assert_ne!(ufrag(&offer), offered, "round {round}: {offer}");
            assert!(
                offer.contains("a=candidate:") && offer.contains(" udp "),
                "round {round}: {offer}"
            );
            let answer = b.answer(&offer, true).await.unwrap();
            assert_ne!(ufrag(&answer), answered, "round {round}: {answer}");
            assert!(answer.contains("a=candidate:"), "round {round}: {answer}");
            a.accept(&answer).await.unwrap();
            (offered, answered) = (ufrag(&offer), ufrag(&answer));

            // The sockets of before are gone: sound that still arrives came over the restarted ICE.
            tokio::time::sleep(Duration::from_secs(2)).await;
            let (a_heard, b_heard) = (a.stats().audio_received, b.stats().audio_received);
            until(
                "both hear after the restart",
                30,
                || {
                    a.stats().audio_received > a_heard + 50
                        && b.stats().audio_received > b_heard + 50
                },
                stats,
            )
            .await;
            for call in [&a, &b] {
                assert!(
                    matches!(call.stats().ice.as_str(), "connected" | "completed"),
                    "round {round}: {}",
                    stats()
                );
            }
        }
        a.close().await;
        b.close().await;
    }

    /// The machine's own camera, as a call opens it with none chosen, gives pictures. Needs a camera, so it runs
    /// only by hand (`cargo test -- --ignored the_default_camera`); on an Intel IPU6 laptop it failed before the
    /// default became the camera GStreamer lists (a bare `v4l2src` there: "not-negotiated", no picture).
    #[test]
    #[ignore = "needs a real camera"]
    fn the_default_camera_gives_pictures() {
        let pictures = Arc::new(AtomicU64::new(0));
        let seen = pictures.clone();
        let camera = Camera::open(
            false,
            None,
            Arc::new(move |jpeg: Vec<u8>| {
                if jpeg.starts_with(&[0xff, 0xd8]) {
                    seen.fetch_add(1, Ordering::Relaxed);
                }
            }),
        )
        .unwrap();
        let end = Instant::now() + Duration::from_secs(8);
        while pictures.load(Ordering::Relaxed) < 5 && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("the default camera: {:?}", devices::default_camera());
        assert!(
            pictures.load(Ordering::Relaxed) >= 5,
            "{} pictures",
            pictures.load(Ordering::Relaxed)
        );
        drop(camera);
    }
}
