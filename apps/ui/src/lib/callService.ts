import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CallState } from "@ghostly/core";
import { notificationPermission, requestNotifications } from "./notifications";
import { androidApp } from "./touchOnly";

/*
 * A call out of sight in the Android app. Android silences the microphone of an app out of sight (Home, another app,
 * the screen off) that runs no foreground service of type microphone, and the backgrounded WebView let the call's
 * connection go: the contact stopped hearing the phone within seconds, and the call ended by itself. While a call is
 * on, Rust's `call_service` holds one (CallService.kt), with an ongoing "Call with <name>" notification whose tap
 * brings the app forward and whose Hang up (`call-hang-up`) ends the call here. Nothing elsewhere.
 */

/** Who the call is with, as the chat shows them, and whether it sends the camera's picture (the camera's service type). */
export interface CallNotice {
  name: string;
  video: boolean;
}

/**
 * Whether the call holds the service: from the dial or the Accept, once the microphone is ours (Android 14 and up
 * start a microphone service only with its permission granted, and the page has it once its stream is there), until
 * the call ends. Not a call that only rings: nothing of it would go silent.
 */
export function callHoldsService(state: CallState, localStream: MediaStream | null): boolean {
  return !!localStream && state !== "idle" && state !== "incoming" && state !== "ended";
}

/**
 * Holds the Android call service while `call` is there, tells it again when the name or the camera changes (never a
 * stop and a start: from the background Android would refuse the start), and stops it with the call or the chat.
 * The notification's Hang up calls `hangUp`. Notifications never asked for are asked for once the call is on: the
 * call's notification is how a person out of the app gets back to it or ends it.
 * `locked`: the app lock is on. The notification then names no one, as every notice of the app does: the shade of an
 * unlocked phone would say who the call is with while the app itself is out of reach behind its lock.
 */
export function useCallService(call: CallNotice | null, hangUp: () => void, locked = false): void {
  const on = call !== null && androidApp();
  const name = locked ? "" : call?.name ?? "";
  const video = call?.video ?? false;
  const hangUpRef = useRef(hangUp);
  hangUpRef.current = hangUp;

  useEffect(() => {
    if (!on) return;
    void invoke<boolean>("call_service", { call: { name, video } }).catch(() => false);
  }, [on, name, video]);

  useEffect(() => {
    if (!on) return;
    let live = true;
    void notificationPermission().then((state) => { if (live && state === "default") void requestNotifications(); });
    const stop = listen("call-hang-up", () => hangUpRef.current());
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten()).catch(() => {});
      void invoke<boolean>("call_service", { call: null }).catch(() => false);
    };
  }, [on]);
}
