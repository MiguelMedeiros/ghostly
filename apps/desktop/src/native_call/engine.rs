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
use bytes::Bytes;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use rtc::media::Sample;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_OPUS, MIME_TYPE_VP8};
use rtc::peer_connection::configuration::RTCOfferOptions;
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
use tokio::sync::{mpsc, Notify};
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
/// The browsers' own STUN server (RTC_CONFIG), for the server reflexive candidate.
const STUN: &str = "stun:stun.l.google.com:19302";
/// Gathering, as `waitForIceGathering` does it: until the reflexive candidate and a moment more, or complete.
const GATHER_TIMEOUT: Duration = Duration::from_secs(10);
const GATHER_SETTLE: Duration = Duration::from_millis(400);
/// How often to ask for a keyframe while no picture has been decoded yet.
const KEYFRAME_UNTIL_PICTURE: Duration = Duration::from_secs(1);

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
/// (`start` reads the error that kept a pipeline from starting).
fn watch(pipeline: &gst::Pipeline, what: &'static str) {
    let Some(bus) = pipeline.bus() else { return };
    let said = AtomicU64::new(0);
    bus.set_sync_handler(move |_, message| {
        let (level, error, debug) = match message.view() {
            gst::MessageView::Error(e) => ("error", e.error().to_string(), e.debug()),
            gst::MessageView::Warning(w) => ("warning", w.error().to_string(), w.debug()),
            _ => return gst::BusSyncReply::Pass,
        };
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
/// such device or it will not start (said in the log; the page sees it in what is used). `ready` sets the
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
            start(&pipeline, what)?;
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
    /// ([`fake_media`]), and the test cameras by name. `preview` gets each frame as a JPEG.
    pub fn open(fake: bool, wanted: Option<&str>, preview: Sink) -> Result<Camera, String> {
        let description = format!(
            "{{device}} ! videoconvert ! videoscale ! videorate \
             ! video/x-raw,format=I420,width={WIDTH},pixel-aspect-ratio=1/1,framerate={FPS}/1 ! tee name=t \
             t. ! queue leaky=downstream max-size-buffers=2 ! appsink name=out sync=false async=false max-buffers=2 drop=true \
             t. ! queue leaky=downstream max-size-buffers=2 ! jpegenc quality=70 \
             ! appsink name=preview sync=false async=false max-buffers=2 drop=true"
        );
        let test = |pattern: &str| format!("videotestsrc is-live=true pattern={pattern}");
        let pretend = wanted
            .filter(|_| fake)
            .and_then(|name| FAKE_CAMERAS.iter().find(|(n, _)| *n == name));
        let target: Arc<Mutex<Option<gst_app::AppSrc>>> = Arc::default();
        let ready = |pipeline: &gst::Pipeline| Camera::wire(pipeline, &target, &preview);
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
        Ok(Camera {
            pipeline,
            target,
            device,
        })
    }

    /// The camera's frames to `target`'s call, and to `preview`.
    fn wire(
        pipeline: &gst::Pipeline,
        target: &Arc<Mutex<Option<gst_app::AppSrc>>>,
        preview: &Sink,
    ) -> Result<(), String> {
        watch(pipeline, "the camera");
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
        each_buffer(&element(pipeline, "preview")?, move |buffer| {
            if let Some(jpeg) = bytes_of(buffer) {
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

/// A microphone open for Settings' meter, until dropped.
pub struct Meter {
    pipeline: gst::Pipeline,
    /// The microphone's name, None for the default one.
    pub device: Option<String>,
}

impl Meter {
    /// The microphone named `wanted`, or the default one (the test tone with `fake`, as in a call). `levels`
    /// gets its loudness, 0 to 1, as JSON (`{"level":0.4}`), about 12 times a second.
    pub fn open(fake: bool, wanted: Option<&str>, levels: Sink) -> Result<Meter, String> {
        let default = if fake { TONE } else { "autoaudiosrc" };
        let (pipeline, device) = start_with(
            "The microphone",
            METER,
            Kind::Microphone,
            wanted,
            default,
            |pipeline| {
                let levels = levels.clone();
                // Read where `level` posts them; anything else (an error) stays on the bus for `start`.
                pipeline
                    .bus()
                    .ok_or("No bus")?
                    .set_sync_handler(move |_, message| {
                        let gst::MessageView::Element(element) = message.view() else {
                            return gst::BusSyncReply::Pass;
                        };
                        let Some(reading) = element.structure().filter(|s| s.name() == "level")
                        else {
                            return gst::BusSyncReply::Pass;
                        };
                        if let Ok(rms) = reading.get::<gst::glib::ValueArray>("rms") {
                            let loudest = rms
                                .iter()
                                .filter_map(|v| v.get::<f64>().ok())
                                .fold(f64::NEG_INFINITY, f64::max);
                            let level = serde_json::json!({ "level": meter_level(loudest) });
                            levels(level.to_string().into_bytes());
                        }
                        gst::BusSyncReply::Drop
                    });
                Ok(())
            },
        )?;
        Ok(Meter { pipeline, device })
    }
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
    candidates: Mutex<(Vec<String>, bool)>,
    gathered: Notify,
    receiving: Mutex<Vec<gst::Pipeline>>,
    /// The speaker chosen for the peer's sound, by name (None: the default).
    speaker: Mutex<Option<String>>,
    /// The peer's sound, once it arrives; replaced when the speaker changes.
    sound: Mutex<Option<Playing>>,
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
            let mut candidates = self.0.candidates.lock().unwrap();
            if !candidates.0.contains(&init.candidate) {
                candidates.0.push(init.candidate);
            }
        }
        self.0.gathered.notify_waiters();
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.0.candidates.lock().unwrap().1 = true;
            self.0.gathered.notify_waiters();
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
             ! videoconvert ! videoscale ! video/x-raw,width=[2,{SHOWN_MAX}],height=[2,{SHOWN_MAX}],pixel-aspect-ratio=1/1 \
             ! jpegenc quality=70 \
             ! appsink name=picture sync=false async=false max-buffers=2 drop=true"
        )
    } else {
        format!(
            "appsrc name=rtp is-live=true format=time do-timestamp=true \
             caps=\"application/x-rtp,media=(string)audio,clock-rate=(int)48000,encoding-name=(string)OPUS,payload=(int){payload_type}\" \
             ! rtpjitterbuffer latency=60 ! rtpopusdepay ! opusdec plc=true name=decoder \
             ! audioconvert ! audioresample ! {{device}}"
        )
    };
    let ready = |pipeline: &gst::Pipeline| receiving(shared, pipeline, video, &decoded, &keyframes);
    if video {
        let pipeline = launch(&description)?;
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

/// Counts what a receiving pipeline decodes and, for pictures, sends them to the page and asks for keyframes.
fn receiving(
    shared: &Arc<Shared>,
    pipeline: &gst::Pipeline,
    video: bool,
    decoded: &Arc<AtomicBool>,
    keyframes: &mpsc::UnboundedSender<()>,
) -> Result<(), String> {
    watch(
        pipeline,
        if video {
            "the peer's video"
        } else {
            "the peer's sound"
        },
    );
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
        // At most SHOWN_FPS pictures a second go to the page (videorate's drop-only asserts on 1.20 here).
        let (events, last) = (shared.events.clone(), Mutex::new(None::<Instant>));
        each_buffer(&element(pipeline, "picture")?, move |buffer| {
            let mut last = last.lock().unwrap();
            let now = Instant::now();
            if last.is_some_and(|at| now - at < Duration::from_secs(1) / SHOWN_FPS) {
                return;
            }
            *last = Some(now);
            if let Some(jpeg) = bytes_of(buffer) {
                events(jpeg);
            }
        });
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

/// Writes what the encoders feed it to a track, from a task, for the whole call.
fn writer(out: Outgoing, payload_type: u8, sent: impl Fn() + Send + 'static) -> Frames {
    let (tx, mut rx) = mpsc::channel::<(Bytes, Duration)>(64);
    tokio::spawn(async move {
        let mut failing = false;
        while let Some((data, duration)) = rx.recv().await {
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

/// The microphone to Opus, for the audio track's writer.
const MICROPHONE: &str = "{device} ! queue ! audioconvert ! audioresample ! volume name=mic \
     ! audio/x-raw,rate=48000,channels=1 ! opusenc bitrate=32000 frame-size=20 \
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
                watch(p, "the microphone");
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
    microphone: Mutex<Microphone>,
    ssrcs: (u32, u32),
}

/// The microphone and the speaker a call starts with, by name (None: the default).
#[derive(Default)]
pub struct Devices {
    pub microphone: Option<String>,
    pub speaker: Option<String>,
}

impl Call {
    /// The pipelines playing and the peer connection ready to offer or answer. `fake`: a test tone and nothing
    /// played by default ([`fake_media`]; a device chosen by name is used all the same). `events` hears the ICE
    /// state (JSON) and each picture that arrives (JPEG).
    pub async fn new(
        opus_pt: u8,
        vp8_pt: u8,
        fake: bool,
        devices: Devices,
        events: Sink,
    ) -> Result<Call, String> {
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
            candidates: Mutex::default(),
            gathered: Notify::new(),
            receiving: Mutex::default(),
            speaker: Mutex::new(devices.speaker),
            sound: Mutex::default(),
            closed: AtomicBool::new(false),
        });
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(
                    RTCConfigurationBuilder::new()
                        .with_ice_servers(vec![RTCIceServer {
                            urls: vec![STUN.to_owned()],
                            ..Default::default()
                        }])
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
            frames: writer(audio, opus_pt, move || {
                counted.counts.audio_sent.fetch_add(1, Ordering::Relaxed);
            }),
            current: Arc::default(),
            muted: AtomicBool::new(false),
        };
        let counted = shared.clone();
        let pictures = writer(video, vp8_pt, move || {
            counted.counts.video_sent.fetch_add(1, Ordering::Relaxed);
        });
        let started = (|| {
            let send = launch(&format!(
                "appsrc name=video is-live=true format=time do-timestamp=true ! queue leaky=downstream max-size-buffers=4 \
                 ! videoconvert ! vp8enc deadline=1 cpu-used=8 threads=2 target-bitrate=600000 end-usage=cbr keyframe-max-dist={FPS} \
                 ! appsink name=vp8 sync=false async=false max-buffers=10 drop=true"
            ))?;
            feed(
                &element(&send, "vp8")?,
                pictures,
                Duration::from_secs(1) / FPS,
                || true,
            );
            watch(&send, "the video encoder");
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
            microphone: Mutex::new(microphone),
            ssrcs,
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
        let previous = std::mem::replace(&mut *microphone, next);
        stop(previous.pipeline);
        crate::diagnostics::log(&format!(
            "native call: microphone {}",
            microphone.device.as_deref().unwrap_or("(default)")
        ));
        Ok(microphone.device.clone())
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

    /// Waits for the candidates worth sending, as `waitForIceGathering` does in a browser.
    async fn gathered(&self) -> Vec<String> {
        let started = Instant::now();
        let mut reflexive_at: Option<Instant> = None;
        loop {
            let notified = self.shared.gathered.notified();
            {
                let candidates = self.shared.candidates.lock().unwrap();
                if candidates.1 {
                    return candidates.0.clone();
                }
                if reflexive_at.is_none() && candidates.0.iter().any(|c| c.contains(" typ srflx")) {
                    reflexive_at = Some(Instant::now());
                }
            }
            let deadline = match reflexive_at {
                Some(at) => at + GATHER_SETTLE,
                None => started + GATHER_TIMEOUT,
            };
            let now = Instant::now();
            if now >= deadline {
                return self.shared.candidates.lock().unwrap().0.clone();
            }
            let _ = tokio::time::timeout(deadline - now, notified).await;
        }
    }

    async fn local(&self, description: RTCSessionDescription) -> Result<String, String> {
        self.pc
            .set_local_description(description)
            .await
            .map_err(|e| e.to_string())?;
        let gathered = self.gathered().await;
        let local = self
            .pc
            .local_description()
            .await
            .ok_or("No local description")?;
        let described = describe(&local.sdp, &gathered, self.ssrcs);
        // Which kinds of candidates went out (not their addresses): why a call never connected, afterwards.
        let kinds: Vec<&str> = described
            .lines()
            .filter(|l| l.starts_with("a=candidate:") && l.split(' ').nth(1) == Some("1"))
            .filter_map(|l| l.split(' ').nth(7))
            .collect();
        crate::diagnostics::log(&format!("native call: {} with {kinds:?}", local.sdp_type));
        Ok(described)
    }

    /// Forgets the candidates gathered so far: the description being made waits for this round's own.
    fn gather_anew(&self) {
        *self.shared.candidates.lock().unwrap() = (Vec::new(), false);
    }

    /// Our offer, gathered: what the page reads its signal from. `restart`: on a call that is up, an offer that
    /// restarts ICE (new credentials, candidates gathered anew) on this same connection.
    pub async fn offer(&self, restart: bool) -> Result<String, String> {
        if restart {
            self.gather_anew();
        }
        let options = restart.then(|| RTCOfferOptions {
            ice_restart: true,
            ..Default::default()
        });
        let offer = self
            .pc
            .create_offer(options)
            .await
            .map_err(|e| e.to_string())?;
        self.local(offer).await
    }

    /// Our answer to the peer's offer (rebuilt from its signal), gathered. `restart`: the offer is the peer's ICE
    /// restart on a call that is up, and ICE restarts here with it.
    pub async fn answer(&self, offer: &str, restart: bool) -> Result<String, String> {
        if restart {
            self.gather_anew();
        }
        let offer = RTCSessionDescription::offer(offer.to_owned()).map_err(|e| e.to_string())?;
        self.pc
            .set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let answer = self
            .pc
            .create_answer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.local(answer).await
    }

    /// The peer's answer to our offer.
    pub async fn accept(&self, answer: &str) -> Result<(), String> {
        let answer = RTCSessionDescription::answer(answer.to_owned()).map_err(|e| e.to_string())?;
        self.pc
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    pub fn set_muted(&self, muted: bool) {
        self.voice.muted.store(muted, Ordering::Relaxed);
        self.microphone
            .lock()
            .unwrap()
            .volume
            .set_property("mute", muted);
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
    // covers: calls.linux-native, calls.reconnect
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
        let a = Call::new(OPUS_PT, VP8_PT, true, Devices::default(), Arc::new(|_| {}))
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
            Arc::new(move |bytes: Vec<u8>| {
                if bytes.starts_with(&[0xff, 0xd8]) {
                    seen.fetch_add(1, Ordering::Relaxed);
                }
            }),
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
        let a = Call::new(OPUS_PT, VP8_PT, true, Devices::default(), Arc::new(|_| {}))
            .await
            .unwrap();
        let offer = a.offer(false).await.unwrap();
        let (opus, vp8) = offered_payload_types(&offer);
        let b = Call::new(opus, vp8, true, Devices::default(), Arc::new(|_| {}))
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
