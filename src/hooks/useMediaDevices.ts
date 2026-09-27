import { useCallback, useEffect, useState } from "react";
import { DEVICES_EVENT, EMPTY_DEVICES, hasMediaDevices, listDevices, loadDeviceChoices, type DeviceChoices, type DeviceList } from "../lib/mediaDevices";

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
} {
  const supported = hasMediaDevices();
  const [list, setList] = useState<DeviceList>(EMPTY_DEVICES);
  const [choices, setChoices] = useState<DeviceChoices>(loadDeviceChoices);

  const refresh = useCallback(async () => {
    const next = await listDevices();
    setList(next);
  }, []);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    const update = () => { void listDevices().then((next) => { if (live) setList(next); }); };
    update();
    navigator.mediaDevices.addEventListener?.("devicechange", update);
    return () => {
      live = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", update);
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
    // Either one is enough for names; a machine with no camera still names its microphones.
    for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
      try {
        const stream = await media.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
        break;
      } catch (error) {
        // A refusal is an answer, not asked again; a missing camera (or microphone) tries the other alone.
        if ((error as { name?: string })?.name === "NotAllowedError") break;
      }
    }
    await refresh();
  }, [refresh]);

  return { supported, list, choices, allowNames };
}
