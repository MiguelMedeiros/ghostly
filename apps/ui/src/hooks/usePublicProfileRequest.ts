import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { engine } from "@ghostly/browser/platform/engine";

/** An identity whose public profile may be asked for (idCard.ts sets it only for a current, verified proof). */
export interface ProfileLookup { provider: string; subject: string }

/**
 * Asks the engine for an identity's public profile once its card is on screen (PUBLIC-PROFILES.md: never in bulk
 * for every contact). The engine decides whether to reach the network: only with Settings → Load public profiles
 * on, online, for a proof still verified, and only when the copy it kept is a day old.
 */
export function usePublicProfileRequest(ref: RefObject<Element | null>, lookup: ProfileLookup | undefined): void {
  const provider = lookup?.provider, subject = lookup?.subject;
  useEffect(() => {
    const el = ref.current;
    if (!provider || !subject || !el) return;
    const ask = () => { void engine.call("loadPublicProfile", { provider, subject }).catch(() => {}); };
    if (typeof IntersectionObserver === "undefined") { ask(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { observer.disconnect(); ask(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, provider, subject]);
}

const subscribe = (listener: () => void) => engine.subscribe(listener);
const loadOn = () => engine.state?.settings.publicProfiles !== false;
/** Settings → Load public profiles: on unless turned off (the engine's `settings.publicProfiles`). */
export function useLoadPublicProfiles(): boolean {
  return useSyncExternalStore(subscribe, loadOn);
}
export function setLoadPublicProfiles(on: boolean): Promise<void> {
  return engine.call("updateSettings", { settings: { publicProfiles: on } });
}
