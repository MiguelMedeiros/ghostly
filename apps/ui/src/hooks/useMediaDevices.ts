import { useCallback, useEffect, useState } from "react";
import { DEVICES_EVENT, EMPTY_DEVICES, hasMediaDevices, isMediaDenied, listDevices, loadDeviceChoices, watchDevices, type DeviceChoices, type DeviceList } from "../lib/mediaDevices";

/**
 * The microphones, cameras and speakers this device has, and which ones this profile chose. The list follows
 * headsets being plugged in and out (`devicechange`), and the choices follow any page of the app.
 */
export function useMediaDevices(): {
  supported: boolean;
  list: DeviceList;
  choices: DeviceChoices;
  /** Asks for the microphone and camera once, so the browser names its devices, and lets them go at once. */
  allowNames: () => Promise<void>;
  /** The last Allow was refused (by the person, the browser or the system): the page says where to turn it back on. */
  denied: boolean;
} {
  const supported = hasMediaDevices();
  const [list, setList] = useState<DeviceList>(EMPTY_DEVICES);
  const [choices, setChoices] = useState<DeviceChoices>(loadDeviceChoices);
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    const next = await listDevices();
    setList(next);
  }, []);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    const update = () => { void listDevices().then((next) => { if (live) setList(next); }); };
    update();
    const stop = watchDevices(update);
    return () => {
      live = false;
      stop();
    };
  }, [supported]);

  useEffect(() => {
    const reload = () => setChoices(loadDeviceChoices());
    window.addEventListener(DEVICES_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(DEVICES_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const allowNames = useCallback(async () => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    let refused = false;
    // Either one is enough for names; a machine with no camera still names its microphones. The first ask stays the
    // tap's own first step, with nothing awaited before it, for a browser that prompts only inside a tap.
    for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
      try {
        const stream = await media.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
        refused = false;
        break;
      } catch (error) {
        // A refusal is an answer, not asked again, and said (iOS refuses at once, with no prompt, once told no);
        // a missing camera (or microphone) tries the other alone.
        refused = isMediaDenied(error);
        if (refused) break;
      }
    }
    setDenied(refused);
    await refresh();
  }, [refresh]);

  return { supported, list, choices, allowNames, denied };
}
