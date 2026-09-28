import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { TypingActivity, TypingKind } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";

/*
 * The typing indicator of a 1:1 chat (WISP 401 § Typing) and of a private group (WISP 9xx · Group Mesh § Typing). The
 * engine says it on the live session (a group's edges) only, throttled, and shows the other side's with a timeout;
 * these hooks read it and tell the engine when this side types or records.
 */

const subscribe = (listener: () => void) => engine.subscribe(listener);

/** No keystroke for this long: this side stopped typing, even with text left in the composer. */
export const TYPING_IDLE_MS = 5_000;
/** The engine is told again at most this often while typing goes on (the wire is throttled there too). */
const TELL_EVERY_MS = 1_000;

/** The contact of this chat is typing now. */
export function usePeerTyping(peerPubKey?: string): boolean {
  return useSyncExternalStore(subscribe, () => !!(peerPubKey && engine.linkByPeer(peerPubKey)?.peerTyping));
}

/** What the contact of this chat is doing now (typing, recording, thinking, a bot's status), or null. */
export function usePeerTypingActivity(peerPubKey?: string): TypingActivity | null {
  const link = () => (peerPubKey ? engine.linkByPeer(peerPubKey) : undefined);
  const typing = useSyncExternalStore(subscribe, () => !!link()?.peerTyping);
  const kind = useSyncExternalStore(subscribe, () => link()?.peerTypingKind ?? "typing");
  const status = useSyncExternalStore(subscribe, () => link()?.peerTypingStatus);
  return useMemo(() => (typing ? { kind, ...(status ? { status } : {}) } : null), [typing, kind, status]);
}

/** Whether contacts are told when this profile is typing; on unless switched off (per profile). */
export function useSendTyping(): boolean {
  return useSyncExternalStore(subscribe, () => engine.state?.settings.sendTyping !== false);
}

export function setSendTyping(on: boolean): Promise<void> {
  return engine.call("updateSettings", { settings: { sendTyping: on } });
}

/**
 * What the composer calls: `true` on a keystroke that leaves text, `false` when the text is cleared or sent; with
 * `"recording"` while a voice note is being recorded (then the contact is told again every second, with no idle
 * stop, until `false`). Typing stops by itself after `TYPING_IDLE_MS` without a keystroke, when `active` goes false
 * (the chat is left), when the page is hidden (a recording carries on), and on unmount. A new kind is told at once.
 */
export function useTypingSender(linkId: string | undefined, active = true): (typing: boolean, kind?: TypingKind) => void {
  const say = useCallback((typing: boolean, kind: TypingKind) => {
    if (linkId) void engine.call("setTyping", { linkId, typing, ...(typing && kind !== "typing" ? { kind } : {}) }).catch(() => {});
  }, [linkId]);
  return useSender(linkId ? say : undefined, active);
}

/** The same for a private group (WISP 9xx · Group Mesh § Typing): the engine says it on the group's edges. */
export function useGroupTypingSender(groupId: string | undefined, active = true): (typing: boolean, kind?: TypingKind) => void {
  const say = useCallback((typing: boolean, kind: TypingKind) => {
    if (groupId) void engine.call("setGroupTyping", { groupId, typing, ...(typing && kind !== "typing" ? { kind } : {}) }).catch(() => {});
  }, [groupId]);
  return useSender(groupId ? say : undefined, active);
}

function useSender(say: ((typing: boolean, kind: TypingKind) => void) | undefined, active: boolean): (typing: boolean, kind?: TypingKind) => void {
  const state = useRef<{
    typing: boolean; kind: TypingKind; toldAt: number;
    idle: ReturnType<typeof setTimeout> | null; keep: ReturnType<typeof setInterval> | null;
  }>({ typing: false, kind: "typing", toldAt: 0, idle: null, keep: null });

  const tell = useCallback((kind: TypingKind) => {
    const now = state.current;
    now.typing = true; now.kind = kind; now.toldAt = Date.now();
    say?.(true, kind);
  }, [say]);

  const stop = useCallback(() => {
    const now = state.current;
    if (now.idle) { clearTimeout(now.idle); now.idle = null; }
    if (now.keep) { clearInterval(now.keep); now.keep = null; }
    if (!now.typing) return;
    now.typing = false; now.toldAt = 0;
    say?.(false, "typing");
  }, [say]);

  const typing = useCallback((on: boolean, kind: TypingKind = "typing") => {
    if (!on || !active || !say) return stop();
    const now = state.current, at = Date.now();
    if (now.idle) { clearTimeout(now.idle); now.idle = null; }
    if (kind === "recording") {
      // No keystrokes while recording: kept said until the recorder stops (the engine sends a start every 3 s).
      if (!now.keep) now.keep = setInterval(() => tell("recording"), TELL_EVERY_MS);
    } else {
      if (now.keep) { clearInterval(now.keep); now.keep = null; }
      now.idle = setTimeout(stop, TYPING_IDLE_MS);
    }
    if (now.typing && now.kind === kind && at - now.toldAt < TELL_EVERY_MS) return;
    tell(kind);
  }, [active, say, stop, tell]);

  useEffect(() => { if (!active) stop(); }, [active, stop]);

  useEffect(() => {
    // A recording goes on in the background (hands-free): it ends when the recorder says so, not here.
    const hidden = () => { if (document.visibilityState === "hidden" && !(state.current.typing && state.current.kind === "recording")) stop(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [stop]);

  return typing;
}
