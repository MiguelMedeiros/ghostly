import { useEffect, type RefObject } from "react";
import { followSpeaker } from "../lib/mediaDevices";

/**
 * The element in `ref` plays on the speaker chosen in Settings, and follows a new choice while it is on screen.
 * `key` is whatever mounts a new element there (its source, a phase), so the new one follows too.
 */
export function useChosenSpeaker(ref: RefObject<HTMLMediaElement | null>, key: unknown): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return followSpeaker(element).stop;
  }, [ref, key]);
}
