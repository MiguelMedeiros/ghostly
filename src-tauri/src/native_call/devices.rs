//! The microphones, cameras and speakers GStreamer sees, known to the page by name.
//!
//! GStreamer gives a device no id the WebView would know, so the page's id for a device is the name listed here
//! (`display_name`, numbered when two devices share one), and a call finds the device again by that name. One
//! `DeviceMonitor` runs for the app's life: its providers (PulseAudio, PipeWire, V4L2) follow devices being
//! plugged in and out, and each change is told to the page (`watch`).

use gst::prelude::*;
use gstreamer as gst;
use serde::Serialize;
use std::sync::{Mutex, OnceLock};

use super::engine::Sink;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Microphone,
    Camera,
    Speaker,
}

impl Kind {
    const ALL: [Kind; 3] = [Kind::Microphone, Kind::Camera, Kind::Speaker];

    fn class(self) -> &'static str {
        match self {
            Kind::Microphone => "Audio/Source",
            Kind::Camera => "Video/Source",
            Kind::Speaker => "Audio/Sink",
        }
    }

    /// The page's word for it (`MediaDeviceInfo.kind`).
    fn page(self) -> &'static str {
        match self {
            Kind::Microphone => "audioinput",
            Kind::Camera => "videoinput",
            Kind::Speaker => "audiooutput",
        }
    }

    pub fn noun(self) -> &'static str {
        match self {
            Kind::Microphone => "microphone",
            Kind::Camera => "camera",
            Kind::Speaker => "speaker",
        }
    }
}

/// A device as the page lists it.
#[derive(Serialize, Debug, PartialEq)]
pub struct Listed {
    pub kind: &'static str,
    pub label: String,
}

/// Test pictures that stand for cameras when `GHOSTLY_FAKE_MEDIA` is set, so the tests can switch between two
/// cameras on a machine with none: the name and `videotestsrc`'s pattern.
pub const FAKE_CAMERAS: [(&str, &str); 2] = [("Test camera", "ball"), ("Test bars", "smpte")];

fn monitor() -> Option<&'static gst::DeviceMonitor> {
    static MONITOR: OnceLock<Option<gst::DeviceMonitor>> = OnceLock::new();
    MONITOR
        .get_or_init(|| {
            gst::init().ok()?;
            let monitor = gst::DeviceMonitor::new();
            for kind in Kind::ALL {
                let _ = monitor.add_filter(Some(kind.class()), None);
            }
            if let Err(error) = monitor.start() {
                crate::diagnostics::log(&format!("native call: no device monitor: {error}"));
                return None;
            }
            Some(monitor)
        })
        .as_ref()
}

/// A microphone that only repeats a speaker (PulseAudio's "Monitor of …"): not a microphone to anyone.
fn is_monitor(device: &gst::Device) -> bool {
    device
        .properties()
        .and_then(|p| p.get::<String>("device.class").ok())
        .is_some_and(|class| class == "monitor")
}

/// Names for devices: their own, with " (2)", " (3)" for more with the same name. A device that another
/// provider already listed under that name (PulseAudio and PipeWire both see the same microphone) is left out.
fn names<T: Clone + PartialEq>(
    devices: impl IntoIterator<Item = (String, T)>,
) -> Vec<(String, usize)> {
    let mut named: Vec<(String, T, String)> = Vec::new();
    let mut out = Vec::new();
    for (index, (name, provider)) in devices.into_iter().enumerate() {
        let same: Vec<&T> = named
            .iter()
            .filter(|(base, _, _)| *base == name)
            .map(|(_, p, _)| p)
            .collect();
        if same.iter().any(|p| **p != provider) {
            continue;
        }
        let label = match same.len() {
            0 => name.clone(),
            n => format!("{name} ({})", n + 1),
        };
        named.push((name, provider, label.clone()));
        out.push((label, index));
    }
    out
}

/// This kind's devices, by the names the page knows them by.
fn devices(kind: Kind) -> Vec<(String, gst::Device)> {
    let Some(monitor) = monitor() else {
        return Vec::new();
    };
    let found: Vec<gst::Device> = monitor
        .devices()
        .into_iter()
        .filter(|d| d.has_classes(kind.class()) && !is_monitor(d))
        .collect();
    // The monitor lists the newest first; the page lists them in the order they came.
    let found: Vec<gst::Device> = found.into_iter().rev().collect();
    names(
        found
            .iter()
            .map(|d| (d.display_name().to_string(), d.type_())),
    )
    .into_iter()
    .map(|(label, index)| (label, found[index].clone()))
    .collect()
}

/// Every microphone, camera and speaker, and the test cameras when the media is fake.
pub fn list(fake: bool) -> Vec<Listed> {
    let mut out = Vec::new();
    for kind in Kind::ALL {
        if kind == Kind::Camera && fake {
            out.extend(FAKE_CAMERAS.iter().map(|(label, _)| Listed {
                kind: kind.page(),
                label: (*label).to_string(),
            }));
        }
        out.extend(devices(kind).into_iter().map(|(label, _)| Listed {
            kind: kind.page(),
            label,
        }));
    }
    out
}

/// The element for the device of this kind with this name, or None when there is no such device (or it will
/// not make one): whoever asked uses the default then, and says so.
pub fn element(kind: Kind, name: &str) -> Option<gst::Element> {
    let (_, device) = devices(kind).into_iter().find(|(label, _)| label == name)?;
    match device.create_element(None) {
        Ok(element) => Some(element),
        Err(error) => {
            crate::diagnostics::log(&format!(
                "native call: the {} \"{name}\" gave no element: {error}",
                kind.noun()
            ));
            None
        }
    }
}

/// How long the bus stays quiet before a burst of changes is told.
const SETTLE: gst::ClockTime = gst::ClockTime::from_mseconds(250);

fn watchers() -> &'static Mutex<Vec<Sink>> {
    static WATCHERS: OnceLock<Mutex<Vec<Sink>>> = OnceLock::new();
    WATCHERS.get_or_init(Mutex::default)
}

/// Tells `changed` each time a device comes or goes, from a thread reading the monitor's bus (started once).
pub fn watch(changed: Sink) {
    watchers().lock().unwrap().push(changed);
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let Some(bus) = monitor().map(|m| m.bus()) else {
            return;
        };
        let spawned = std::thread::Builder::new()
            .name("device-watch".into())
            .spawn(move || {
                let changes = [
                    gst::MessageType::DeviceAdded,
                    gst::MessageType::DeviceRemoved,
                ];
                loop {
                    if bus
                        .timed_pop_filtered(gst::ClockTime::NONE, &changes)
                        .is_none()
                    {
                        continue;
                    }
                    // Changes come in bursts (a headset is a microphone and a speaker; every device at start):
                    // told once, when the bus has been quiet a moment and the providers' lists are settled.
                    while bus.timed_pop_filtered(SETTLE, &changes).is_some() {}
                    crate::diagnostics::log("native call: the devices changed");
                    for tell in watchers().lock().unwrap().iter() {
                        tell(b"{\"devices\":\"changed\"}".to_vec());
                    }
                }
            });
        if let Err(error) = spawned {
            crate::diagnostics::log(&format!("native call: no device watch: {error}"));
        }
    });
}

#[cfg(test)]
mod tests {
    // covers: calls.devices-linux
    use super::*;

    #[test]
    fn devices_with_one_name_are_numbered_and_another_providers_copy_is_left_out() {
        let seen = [
            ("Webcam".to_string(), "v4l2"),
            ("Built-in Audio".to_string(), "pulse"),
            ("Webcam".to_string(), "v4l2"),
            ("Built-in Audio".to_string(), "pipewire"),
            ("Webcam".to_string(), "v4l2"),
        ];
        assert_eq!(
            names(seen),
            vec![
                ("Webcam".to_string(), 0),
                ("Built-in Audio".to_string(), 1),
                ("Webcam (2)".to_string(), 2),
                ("Webcam (3)".to_string(), 4),
            ]
        );
    }

    #[test]
    fn the_test_cameras_are_listed_only_with_fake_media() {
        let cameras = |fake| {
            list(fake)
                .into_iter()
                .filter(|d| {
                    d.kind == "videoinput" && FAKE_CAMERAS.iter().any(|(n, _)| *n == d.label)
                })
                .count()
        };
        assert_eq!(cameras(true), FAKE_CAMERAS.len());
        assert_eq!(cameras(false), 0);
    }
}
