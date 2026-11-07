import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { androidApp } from "./touchOnly";

/*
 * The composer's Camera refused in the Android app. The phone's camera opens from a file input, and a refusal of
 * Android's CAMERA permission reaches that input as a plain cancel: Camera did nothing, and once Android stopped
 * asking ("Don't allow" twice, "Don't ask again") it did nothing for good. The app says it (CameraCapture.kt, Rust's
 * `camera-refused`: "refused", or "blocked" when Android no longer asks), and only to the composer whose Camera was
 * tapped last. Nothing elsewhere: a browser's file input never asks for the camera.
 */

const EVENT = "camera-refused";
/** The composer whose Camera was tapped last. */
let asker: object | null = null;

/**
 * Calls `onRefused` when Android refuses this composer's Camera (`blocked`: only Android's settings allow it now).
 * Returns what the Camera tap calls first, which makes this composer the one asking.
 */
export function useCameraRefusal(onRefused: (blocked: boolean) => void): () => void {
  const own = useRef({});
  const handler = useRef(onRefused);
  handler.current = onRefused;
  useEffect(() => {
    if (!androidApp()) return;
    const me = own.current;
    const stop = listen<string>(EVENT, ({ payload }) => { if (asker === me) handler.current(payload === "blocked"); });
    return () => {
      if (asker === me) asker = null;
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return useCallback(() => { asker = own.current; }, []);
}

/** The app's own page in Android's settings, where a permission Android no longer asks for is allowed again. */
export async function openAppSettings(): Promise<void> {
  try { await invoke("open_app_settings"); } catch { /* nothing to open here */ }
}
