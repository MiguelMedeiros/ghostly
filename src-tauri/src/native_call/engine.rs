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
//! The page drives this through `src/desktop/nativeCalls.ts`, which looks like an `RTCPeerConnection` to the
//! call hook.

use bytes::Bytes;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use rtc::media::Sample;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_OPUS, MIME_TYPE_VP8};
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
    RTCIceGatheringState, RTCIceServer, RTCPeerConnectionIceEvent, RTCSessionDescription, Registry,
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

/// A camera, open until dropped; its frames go to the call it is attached to, if any.
pub struct Camera {
    pipeline: gst::Pipeline,
    target: Arc<Mutex<Option<gst_app::AppSrc>>>,
}

impl Camera {
    /// `fake`: a test picture instead of the camera ([`fake_media`]). `preview` gets each frame as a JPEG.
    pub fn open(fake: bool, preview: Sink) -> Result<Camera, String> {
        let source = if fake {
            "videotestsrc is-live=true pattern=ball"
        } else {
            "v4l2src"
        };
        let pipeline = launch(&format!(
            "{source} ! videoconvert ! videoscale ! videorate \
             ! video/x-raw,format=I420,width={WIDTH},pixel-aspect-ratio=1/1,framerate={FPS}/1 ! tee name=t \
             t. ! queue leaky=downstream max-size-buffers=2 ! appsink name=out sync=false async=false max-buffers=2 drop=true \
             t. ! queue leaky=downstream max-size-buffers=2 ! jpegenc quality=70 \
             ! appsink name=preview sync=false async=false max-buffers=2 drop=true"
        ))?;
        let target: Arc<Mutex<Option<gst_app::AppSrc>>> = Arc::default();
        let to = target.clone();
        element::<gst_app::AppSink>(&pipeline, "out")?.set_callbacks(
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
        each_buffer(&element(&pipeline, "preview")?, move |buffer| {
            if let Some(jpeg) = bytes_of(buffer) {
                preview(jpeg);
            }
        });
        start(&pipeline, "The camera")?;
        Ok(Camera { pipeline, target })
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
    while let Some(event) = track.poll().await {
        if shared.closed.load(Ordering::Relaxed) {
            break;
        }
        let TrackRemoteEvent::OnRtpPacket(packet) = event else {
            continue;
        };
        if input.is_none() {
            match receiver(
                &shared,
                video,
                packet.header.payload_type,
                decoded.clone(),
                keyframe_tx.clone(),
            ) {
                Ok(src) => input = Some(src),
                Err(error) => {
                    let kind = if video { "video" } else { "audio" };
                    crate::diagnostics::log(&format!("native call: no {kind} receiver: {error}"));
                    return;
                }
            }
            if let (true, Some(mut asked)) = (video, keyframe_rx.take()) {
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

fn receiver(
    shared: &Arc<Shared>,
    video: bool,
    payload_type: u8,
    decoded: Arc<AtomicBool>,
    keyframes: mpsc::UnboundedSender<()>,
) -> Result<gst_app::AppSrc, String> {
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
        let speakers = if shared.fake {
            "fakesink sync=true async=false"
        } else {
            "autoaudiosink"
        };
        format!(
            "appsrc name=rtp is-live=true format=time do-timestamp=true \
             caps=\"application/x-rtp,media=(string)audio,clock-rate=(int)48000,encoding-name=(string)OPUS,payload=(int){payload_type}\" \
             ! rtpjitterbuffer latency=60 ! rtpopusdepay ! opusdec plc=true name=decoder \
             ! audioconvert ! audioresample ! {speakers}"
        )
    };
    let pipeline = launch(&description)?;
    let src: gst_app::AppSrc = element(&pipeline, "rtp")?;
    let counting = shared.clone();
    let decoder: gst::Element = element(&pipeline, "decoder")?;
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
            count.fetch_add(1, Ordering::Relaxed);
            decoded.store(true, Ordering::Relaxed);
            counting.media_arrived();
            gst::PadProbeReturn::Ok
        });
    if video {
        // At most SHOWN_FPS pictures a second go to the page (videorate's drop-only asserts on 1.20 here).
        let (events, last) = (shared.events.clone(), Mutex::new(None::<Instant>));
        each_buffer(&element(&pipeline, "picture")?, move |buffer| {
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
    start(
        &pipeline,
        if video { "The picture" } else { "The speakers" },
    )?;
    shared.receiving.lock().unwrap().push(pipeline);
    Ok(src)
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
        ..Default::default()
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

/// Writes what an encoder makes to a track, from a task: GStreamer's threads only queue it.
fn write_from(
    appsink: &gst_app::AppSink,
    out: Outgoing,
    payload_type: u8,
    frame: Duration,
    sent: impl Fn() + Send + 'static,
) {
    let (tx, mut rx) = mpsc::channel::<(Bytes, Duration)>(64);
    each_buffer(appsink, move |buffer| {
        let duration = buffer
            .duration()
            .map(|d| Duration::from_nanos(d.nseconds()))
            .unwrap_or(frame);
        if let Some(bytes) = bytes_of(buffer) {
            // Before the call connects, or when writing falls behind, frames are dropped rather than queued.
            let _ = tx.try_send((Bytes::from(bytes), duration));
        }
    });
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
}

/// One call: a peer connection, and the pipelines that feed it and play what it brings.
pub struct Call {
    pc: Arc<dyn PeerConnection>,
    shared: Arc<Shared>,
    send: gst::Pipeline,
    video_in: gst_app::AppSrc,
    mic: gst::Element,
    ssrcs: (u32, u32),
}

impl Call {
    /// The pipelines playing and the peer connection ready to offer or answer. `fake`: a test tone and nothing
    /// played ([`fake_media`]). `events` hears the ICE state (JSON) and each picture that arrives (JPEG).
    pub async fn new(opus_pt: u8, vp8_pt: u8, fake: bool, events: Sink) -> Result<Call, String> {
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

        let microphone = if fake {
            "audiotestsrc is-live=true wave=sine freq=440 volume=0.2"
        } else {
            "autoaudiosrc"
        };
        let send = launch(&format!(
            "{microphone} ! queue ! audioconvert ! audioresample ! volume name=mic \
             ! audio/x-raw,rate=48000,channels=1 ! opusenc bitrate=32000 frame-size=20 \
             ! appsink name=opus sync=false async=false max-buffers=50 drop=true \
             appsrc name=video is-live=true format=time do-timestamp=true ! queue leaky=downstream max-size-buffers=4 \
             ! videoconvert ! vp8enc deadline=1 cpu-used=8 threads=2 target-bitrate=600000 end-usage=cbr keyframe-max-dist={FPS} \
             ! appsink name=vp8 sync=false async=false max-buffers=10 drop=true"
        ))?;
        let counted = shared.clone();
        write_from(
            &element(&send, "opus")?,
            audio,
            opus_pt,
            Duration::from_millis(20),
            move || {
                counted.counts.audio_sent.fetch_add(1, Ordering::Relaxed);
            },
        );
        let counted = shared.clone();
        write_from(
            &element(&send, "vp8")?,
            video,
            vp8_pt,
            Duration::from_secs(1) / FPS,
            move || {
                counted.counts.video_sent.fetch_add(1, Ordering::Relaxed);
            },
        );
        let video_in = element(&send, "video")?;
        let mic = element(&send, "mic")?;
        if let Err(error) = start(&send, "The microphone") {
            let _ = pc.close().await;
            return Err(error);
        }
        Ok(Call {
            pc,
            shared,
            send,
            video_in,
            mic,
            ssrcs,
        })
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
        Ok(describe(&local.sdp, &gathered, self.ssrcs))
    }

    /// Our offer, gathered: what the page reads its signal from.
    pub async fn offer(&self) -> Result<String, String> {
        let offer = self
            .pc
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.local(offer).await
    }

    /// Our answer to the peer's offer (rebuilt from its signal), gathered.
    pub async fn answer(&self, offer: &str) -> Result<String, String> {
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
        self.mic.set_property("mute", muted);
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
        }
    }

    /// Hangs up: the connection closed, every pipeline stopped.
    pub async fn close(&self) {
        self.shared.closed.store(true, Ordering::Relaxed);
        let _ = self.pc.close().await;
        let mut pipelines = std::mem::take(&mut *self.shared.receiving.lock().unwrap());
        pipelines.push(self.send.clone());
        let _ = tokio::task::spawn_blocking(move || pipelines.into_iter().for_each(stop)).await;
    }
}

#[cfg(test)]
mod tests {
    // covers: calls.linux-native
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
    fn the_description_carries_ssrcs_and_every_candidate_once_in_lower_case() {
        let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=candidate:9 1 UDP 1 1.2.3.4 5 typ host\r\n\
                   a=end-of-candidates\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ssrc:7 cname:x\r\n";
        let gathered = [
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
                "a=candidate:9 1 udp 1 1.2.3.4 5 typ host\r\na=candidate:1 1 udp 2015363327 172.17.0.2 38415 typ host\r\n"
            ),
            "{out}"
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
        let a = Call::new(OPUS_PT, VP8_PT, true, Arc::new(|_| {}))
            .await
            .unwrap();
        let a_camera = Camera::open(true, Arc::new(|_| {})).unwrap();
        a_camera.attach(Some(a.video_input()));
        let offer = a.offer().await.unwrap();
        assert!(
            offer.contains("a=candidate:") && offer.contains(" udp "),
            "{offer}"
        );
        let (opus, vp8) = offered_payload_types(&offer);
        let b = Call::new(
            opus,
            vp8,
            true,
            Arc::new(move |bytes: Vec<u8>| {
                if bytes.starts_with(&[0xff, 0xd8]) {
                    seen.fetch_add(1, Ordering::Relaxed);
                }
            }),
        )
        .await
        .unwrap();
        let answer = b.answer(&offer).await.unwrap();
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
        // The answerer's camera comes on halfway, as it does in a voice call: no new offer.
        assert_eq!(a.stats().video_received, 0, "{}", stats());
        let b_camera = Camera::open(true, Arc::new(|_| {})).unwrap();
        b_camera.attach(Some(b.video_input()));
        until(
            "the offerer sees",
            30,
            || a.stats().video_received > 5,
            stats,
        )
        .await;
        a.close().await;
        b.close().await;
    }
}
