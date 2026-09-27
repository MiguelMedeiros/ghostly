import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";

/*
 * The typing indicator of a 1:1 chat (WISP 401 § Typing). The engine says it on the live session only, throttled,
 * and shows the contact's with a timeout; these hooks read it and tell the engine when this side types.
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

/** Whether contacts are told when this profile is typing; on unless switched off (per profile). */
export function useSendTyping(): boolean {
  return useSyncExternalStore(subscribe, () => engine.state?.settings.sendTyping !== false);
}

export function setSendTyping(on: boolean): Promise<void> {
  return engine.call("updateSettings", { settings: { sendTyping: on } });
}

/**
 * What the composer calls: `true` on a keystroke that leaves text, `false` when the text is cleared or sent. Stops by
 * itself after `TYPING_IDLE_MS` without a keystroke, when `active` goes false (the chat is left), when the page is
 * hidden, and on unmount.
 */
export function useTypingSender(linkId: string | undefined, active = true): (typing: boolean) => void {
  const state = useRef<{ typing: boolean; toldAt: number; idle: ReturnType<typeof setTimeout> | null }>({ typing: false, toldAt: 0, idle: null });

  const stop = useCallback(() => {
    const now = state.current;
    if (now.idle) { clearTimeout(now.idle); now.idle = null; }
    if (!now.typing) return;
    now.typing = false; now.toldAt = 0;
    if (linkId) void engine.call("setTyping", { linkId, typing: false }).catch(() => {});
  }, [linkId]);

  const typing = useCallback((on: boolean) => {
    if (!on || !active || !linkId) return stop();
    const now = state.current, at = Date.now();
    if (now.idle) clearTimeout(now.idle);
    now.idle = setTimeout(stop, TYPING_IDLE_MS);
    if (now.typing && at - now.toldAt < TELL_EVERY_MS) return;
    now.typing = true; now.toldAt = at;
    void engine.call("setTyping", { linkId, typing: true }).catch(() => {});
  }, [active, linkId, stop]);

  useEffect(() => { if (!active) stop(); }, [active, stop]);

  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") stop(); };
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
