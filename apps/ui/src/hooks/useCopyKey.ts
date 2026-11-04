import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/shareLink";

/**
 * Copies a key (an ID card's back, a DID, an error's details) and says what happened for a moment. A key is copied to
 * be compared elsewhere, so "Copied" is said only once it is: a refused copy leaves the clipboard as it was, maybe
 * holding another key. `failed` is for the caller to say so (the key stays on screen, selectable).
 */
export function useCopyKey(key: string) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = (next: "copied" | "failed") => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), next === "copied" ? 1500 : 4000);
  };
  return {
    copied: state === "copied",
    failed: state === "failed",
    copy: () => { void copyText(key).then(() => settle("copied"), () => settle("failed")); },
  };
}
