import { useEffect, useRef, useState } from "react";
import { copySecret, copyText } from "../lib/shareLink";

/**
 * Copy on money in a message (an invoice, an address, a token). What is copied is pasted into another wallet, so
 * "Copied" is said only once it is: a refused copy leaves the clipboard as it was, maybe holding another address.
 * `failed` shows `MoneyCopyRefused` (components/MoneyCopy.tsx) on the card. `secret`: the value is the money itself (a
 * Cashu token, which whoever reads it can spend), copied as `copySecret`.
 */
export function useMoneyCopy(value: string, secret = false) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    copied: state === "copied",
    failed: state === "failed",
    copy: async () => {
      clearTimeout(timer.current);
      try {
        await (secret ? copySecret : copyText)(value);
      } catch {
        setState("failed");
        return;
      }
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 1500);
    },
  };
}
