import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEVICES_EVENT,
  EMPTY_DEVICES,
  canPickSpeaker,
  chooseDevice,
  deviceSource,
  listDevices,
  loadDeviceChoices,
  resolveDevice,
  trackDevice,
  watchDevices,
  type DeviceChoices,
  type DeviceKind,
  type DeviceList,
} from "../lib/mediaDevices";

/** What the call hook (`useWebRTC`) gives this one. */
interface CallMediaControls {
  callState: string;
  localStream: MediaStream | null;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  canSwitchDevices: boolean;
  switchMicrophone: (deviceId: string | null) => Promise<void>;
  switchCamera: (deviceId: string | null) => Promise<void>;
}

/** A device went away mid-call and the default took over, or the chosen one came back. */
export interface DeviceNotice {
  kind: DeviceKind;
  type: "lost" | "back";
  name: string;
  /** For "back": the device to switch back to. */
  id?: string;
}

export interface CallDevices {
  list: DeviceList;
  /** What each kind uses now: a device id, or "" for the default. */
  current: Record<DeviceKind, string>;
  /** The speaker the call plays on (undefined: the default), for `setSinkId`. */
  speaker: string | undefined;
  /** Whether a speaker can be chosen here. */
  speakers: boolean;
  choose: (kind: DeviceKind, deviceId: string) => void;
  notice: DeviceNotice | null;
  dismiss: () => void;
  switchBack: () => void;
}

/** How long a notice stays. */
export const DEVICE_NOTICE_MS = 10_000;

/** Browsers' "follow the system" entries, which are the default. */
const followsSystem = (id: string | undefined) => !id || id === "default" || id === "communications";

/**
 * The device menu of a call and what keeps it honest: switching the microphone, camera and speaker live (a
 * choice made here is this profile's from then on, and one made in Settings during the call reaches it too), and
 * following headsets in and out. When the device a call
 * uses disappears, the call goes on with the default and says so; when the chosen one comes back, it offers
 * to switch back. Null where the call's media cannot switch devices or no call is on.
 */
export function useCallDevices(webrtc: CallMediaControls): CallDevices | null {
  const active = webrtc.callState !== "idle" && webrtc.callState !== "incoming" && webrtc.canSwitchDevices;
  const [list, setList] = useState<DeviceList>(EMPTY_DEVICES);
  const [speaker, setSpeaker] = useState<string | undefined>();
  const [notice, setNoticeState] = useState<DeviceNotice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setNotice = useCallback((next: DeviceNotice | null) => {
    clearTimeout(timer.current);
    setNoticeState(next);
    if (next) timer.current = setTimeout(() => setNoticeState(null), DEVICE_NOTICE_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const audioTrack = webrtc.localStream?.getAudioTracks()[0];
  const cameraOn = !webrtc.isVideoOff && !webrtc.isScreenSharing;
  const videoTrack = cameraOn ? webrtc.localStream?.getVideoTracks()[0] : undefined;
  const micNow = trackDevice(audioTrack);
  const cameraNow = trackDevice(videoTrack);

  // What the call is using, read fresh by the device checks below.
  const state = useRef({ webrtc, micNow, cameraNow, audioTrack, videoTrack, speaker, cameraOn, list });
  state.current = { webrtc, micNow, cameraNow, audioTrack, videoTrack, speaker, cameraOn, list };
  /** The choices this call last followed: a change elsewhere (Settings, another page) is what differs from them. */
  const followed = useRef<DeviceChoices>({});
  /** A choice made in this call's menu, which switches by itself. */
  const choosing = useRef(false);
  /** A switch is under way: the device checks wait for it instead of starting another. */
  const busy = useRef(false);
  /** What was told this call (`<kind>:<id>` a device offered back, `<kind>:missing` a loss), so each is told once. */
  const offered = useRef(new Set<string>());

  const run = useCallback(async (work: () => Promise<void>) => {
    busy.current = true;
    try {
      await work();
    } catch {
      // The call goes on with what it had.
    } finally {
      busy.current = false;
    }
  }, []);

  /** After the devices changed: falls back from a device that went away, offers one that came back. */
  const check = useCallback(async (next: DeviceList) => {
    if (busy.current || !next.named) return;
    const { webrtc: call, micNow: mic, cameraNow: camera, audioTrack: audio, videoTrack: video, speaker: sink, cameraOn: showing } = state.current;
    const gone = (kind: DeviceKind, id: string | undefined, track?: MediaStreamTrack) =>
      track?.readyState === "ended" || (!followsSystem(id) && !next[kind].some((d) => d.id === id));
    /** A loss is told now; the chosen device coming back is offered again, and not told missing on top. */
    const lost = (kind: DeviceKind, name: string) => {
      for (const key of [...offered.current]) if (key.startsWith(`${kind}:`)) offered.current.delete(key);
      offered.current.add(`${kind}:missing`);
      setNotice({ kind, type: "lost", name });
    };

    if (audio && gone("audioinput", mic, audio)) {
      lost("audioinput", audio.label);
      await run(() => call.switchMicrophone(null));
      return;
    }
    if (showing && video && gone("videoinput", camera, video)) {
      lost("videoinput", video.label);
      await run(() => call.switchCamera(null));
      return;
    }
    if (sink && !next.audiooutput.some((d) => d.id === sink)) {
      lost("audiooutput", loadDeviceChoices().audiooutput?.label ?? "");
      setSpeaker(undefined);
      return;
    }

    const choices = loadDeviceChoices();
    // The chosen device was not there when the call started: it began on the default, and says so once.
    for (const kind of ["audioinput", "videoinput", "audiooutput"] as const) {
      const { missing } = resolveDevice(kind, next, choices);
      if (!missing || (kind === "videoinput" && !showing) || (kind === "audiooutput" && !canPickSpeaker()) || offered.current.has(`${kind}:missing`)) continue;
      offered.current.add(`${kind}:missing`);
      setNotice({ kind, type: "lost", name: missing });
      return;
    }

    // The chosen device is back (it went, or was missing when the call started), and the call is not using it: offer
    // it, once. Only after a loss: a call still setting up its speaker has nothing to offer.
    const now: Partial<Record<DeviceKind, string | undefined>> = { audioinput: mic, videoinput: showing ? camera : undefined, audiooutput: sink };
    for (const kind of ["audioinput", "videoinput", "audiooutput"] as const) {
      const chosen = choices[kind];
      if (!chosen || !offered.current.has(`${kind}:missing`) || (kind === "videoinput" && !showing) || (kind === "audiooutput" && !canPickSpeaker())) continue;
      if (kind !== "audiooutput" && now[kind] === undefined) continue;
      const { id } = resolveDevice(kind, next, choices);
      if (!id || id === now[kind] || offered.current.has(`${kind}:${id}`)) continue;
      offered.current.add(`${kind}:${id}`);
      setNotice({ kind, type: "back", name: chosen.label, id });
      return;
    }
  }, [run, setNotice]);

  // The devices, while a call is on: now, and at every plug and unplug.
  useEffect(() => {
    if (!active) return;
    let live = true;
    const update = () => {
      void listDevices().then((next) => {
        if (!live) return;
        setList(next);
        void check(next);
      });
    };
    update();
    const stop = watchDevices(update);
    return () => {
      live = false;
      stop();
    };
  }, [active, check]);

  // An unplugged microphone or camera may end its track before the device list says anything.
  useEffect(() => {
    if (!active) return;
    const tracks = [audioTrack, videoTrack].filter((t): t is MediaStreamTrack => !!t);
    const ended = () => { void listDevices().then((next) => { setList(next); void check(next); }); };
    tracks.forEach((t) => t.addEventListener?.("ended", ended));
    return () => tracks.forEach((t) => t.removeEventListener?.("ended", ended));
  }, [active, audioTrack, videoTrack, check]);

  // The speaker the profile chose, from the start of each call; the offers are made again in the next call.
  useEffect(() => {
    if (!active) {
      setSpeaker(undefined);
      setNotice(null);
      offered.current.clear();
      return;
    }
    if (canPickSpeaker()) setSpeaker(loadDeviceChoices().audiooutput?.id);
  }, [active, setNotice]);

  // Where the call's sound plays outside the page (Linux Desktop's native calls), the speaker goes there too.
  useEffect(() => {
    if (active) deviceSource()?.playCallOn(speaker);
  }, [active, speaker]);
  // A device chosen in Settings (or on another page of the app) while the call is on: the call switches to it, the
  // same way as from its own menu.
  useEffect(() => {
    if (!active) return;
    followed.current = loadDeviceChoices();
    const follow = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== null && !event.key.endsWith("media_devices")) return;
      const was = followed.current;
      const next = loadDeviceChoices();
      followed.current = next;
      if (choosing.current) return;
      const changed = (["audioinput", "videoinput", "audiooutput"] as const).filter((kind) => (next[kind]?.id ?? "") !== (was[kind]?.id ?? ""));
      if (changed.length === 0) return;
      const { webrtc: call, micNow: mic, cameraNow: camera, cameraOn: showing, list: devices } = state.current;
      for (const kind of changed) for (const key of [...offered.current]) if (key.startsWith(`${kind}:`)) offered.current.delete(key);
      setNotice(null);
      /** The device to use now: the chosen one as this page knows it, or the default (null) when it is not here. */
      const target = (kind: DeviceKind) => (next[kind] ? resolveDevice(kind, devices, next).id ?? null : null);
      const using = (id: string | undefined) => (followsSystem(id) ? null : id);
      if (changed.includes("audiooutput") && canPickSpeaker()) setSpeaker(target("audiooutput") ?? undefined);
      const micTo = changed.includes("audioinput") ? target("audioinput") : undefined;
      const cameraTo = changed.includes("videoinput") && showing ? target("videoinput") : undefined;
      if ((micTo === undefined || micTo === using(mic)) && (cameraTo === undefined || cameraTo === using(camera))) return;
      void run(async () => {
        if (micTo !== undefined && micTo !== using(mic)) await call.switchMicrophone(micTo);
        if (cameraTo !== undefined && cameraTo !== using(camera)) await call.switchCamera(cameraTo);
      });
    };
    window.addEventListener(DEVICES_EVENT, follow);
    window.addEventListener("storage", follow);
    return () => {
      window.removeEventListener(DEVICES_EVENT, follow);
      window.removeEventListener("storage", follow);
    };
  }, [active, run, setNotice]);

  const choose = useCallback((kind: DeviceKind, deviceId: string) => {
    const device = list[kind].find((d) => d.id === deviceId);
    choosing.current = true;
    try {
      chooseDevice(kind, deviceId ? { id: deviceId, label: device?.label ?? "" } : null);
    } finally {
      choosing.current = false;
    }
    setNotice(null);
    const { webrtc: call } = state.current;
    if (kind === "audioinput") void run(() => call.switchMicrophone(deviceId || null));
    else if (kind === "videoinput") void run(() => call.switchCamera(deviceId || null));
    else setSpeaker(deviceId || undefined);
  }, [list, run, setNotice]);

  const switchBack = useCallback(() => {
    if (notice?.type === "back" && notice.id) choose(notice.kind, notice.id);
  }, [notice, choose]);

  if (!active) return null;
  const choices = loadDeviceChoices();
  const shown = (id: string | undefined, kind: DeviceKind) => (id === undefined ? resolveDevice(kind, list, choices).id ?? "" : followsSystem(id) ? "" : id);
  return {
    list,
    current: {
      audioinput: shown(micNow, "audioinput"),
      videoinput: cameraOn ? shown(cameraNow, "videoinput") : resolveDevice("videoinput", list, choices).id ?? "",
      audiooutput: speaker ?? "",
    },
    speaker,
    speakers: canPickSpeaker() && list.audiooutput.length > 0,
    choose,
    notice,
    dismiss: () => setNotice(null),
    switchBack,
  };
}
