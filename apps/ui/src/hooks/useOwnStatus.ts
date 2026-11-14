import { useEffect, useRef, useState } from "react";
import { liveStatus, type PersonStatus, type Presence } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { useEngineValue } from "../lib/engineState";

/**
 * This profile's status while it lasts, as the engine says it (`getOwnStatus`), asked again whenever the status or the
 * switch changes in its state (set here, from another page, or ended at its time). Until it answers, the state's own.
 */
export function useOwnStatus(): { status?: PersonStatus; sharePresence: boolean } {
  const stored = useEngineValue((state) => ({ status: state?.settings.ownStatus, sharePresence: state?.settings.sharePresence !== false }));
  const [said, setSaid] = useState<{ for: typeof stored; status?: PersonStatus; sharePresence: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    engine.call("getOwnStatus").then(({ status, sharePresence }) => { if (live) setSaid({ for: stored, status, sharePresence }); }, () => {});
    return () => { live = false; };
  }, [stored]);
  if (said?.for === stored) return { status: said.status, sharePresence: said.sharePresence };
  return { status: liveStatus(stored.status), sharePresence: stored.sharePresence };
}

/** Settings, "Share when I'm online": on unless switched off (per profile). */
export function useSharePresence(): boolean {
  return useEngineValue((state) => state?.settings.sharePresence !== false);
}

/** While the person goes on using the app, the engine is told again this often (it says idle 10 minutes after the last). */
export const PRESENCE_TELL_EVERY_MS = 60_000;

/**
 * Tells the engine whether the person is here (WISP 401 § Presence and status): `active` as the page shows and on input
 * (a key, a click, a touch, a scroll), at most once a minute while it goes on; `idle` when the page is hidden or goes,
 * and while the lock screen is up (a password typed there is not using the app). The engine goes idle by itself after
 * 10 minutes without a word; nothing is said by a page hidden from the start.
 */
export function usePresence(locked: boolean): void {
  const told = useRef<{ presence?: Presence; at: number }>({ at: 0 });
  useEffect(() => {
    const say = (presence: Presence) => {
      const last = told.current;
      if (presence === last.presence && (presence === "idle" || Date.now() - last.at < PRESENCE_TELL_EVERY_MS)) return;
      // A page hidden from the start has nothing to take back.
      if (presence === "idle" && !last.presence) return;
      told.current = { presence, at: Date.now() };
      void engine.call("setPresence", { presence }).catch(() => {});
    };
    const here = () => say(!locked && document.visibilityState !== "hidden" ? "active" : "idle");
    const input = () => { if (!locked) say("active"); };
    const gone = () => say("idle");
    here();
    const inputs = ["keydown", "pointerdown", "wheel"] as const;
    for (const name of inputs) window.addEventListener(name, input, { capture: true, passive: true });
    document.addEventListener("visibilitychange", here);
    window.addEventListener("pagehide", gone);
    return () => {
      for (const name of inputs) window.removeEventListener(name, input, { capture: true });
      document.removeEventListener("visibilitychange", here);
      window.removeEventListener("pagehide", gone);
    };
  }, [locked]);
}
