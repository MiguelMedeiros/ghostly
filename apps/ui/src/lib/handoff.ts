import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { HandoffFailure, HandoffView } from "@ghostly/browser/devices/handoff";
import type { TranslationKey } from "../contexts/I18nContext";
import { WALLET_NAME } from "../components/wallet/names";

/* The handoff (WISP 06 § The handoff) as the pages need it: what a failure says, sizes, and the view of the engine's. */

/** A size as people read it: "480 MB", "1.2 GB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const FAILURES: Record<HandoffFailure, TranslationKey> = {
  unreachable: "devices.handoff.fail.unreachable", password: "devices.handoff.fail.password", "locked-out": "devices.handoff.fail.lockedOut",
  refused: "devices.handoff.fail.refused", payment: "devices.handoff.fail.payment", call: "devices.handoff.fail.call", busy: "devices.handoff.fail.busy",
  older: "devices.handoff.fail.older", room: "devices.handoff.fail.room", damaged: "devices.handoff.fail.damaged", dropped: "devices.handoff.fail.dropped",
  wallet: "devices.handoff.fail.wallet", loading: "devices.handoff.fail.loading", mainnet: "devices.handoff.fail.mainnet", expiry: "devices.handoff.fail.expiry",
  cancelled: "devices.handoff.fail.cancelled", turn: "devices.handoff.fail.turn", offline: "devices.handoff.fail.offline",
  version: "devices.handoff.fail.version", failed: "devices.handoff.fail.failed", woken: "devices.handoff.fail.woken",
  stalled: "devices.handoff.fail.stalled",
};

/** The failure an engine call ended with (`handoff-<reason>:`), or null for another error. */
export function handoffErrorKey(error: unknown): TranslationKey | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason = message.match(/^handoff-([a-z-]+):/)?.[1];
  return reason && reason in FAILURES ? FAILURES[reason as HandoffFailure] : reason ? "devices.handoff.fail.failed" : null;
}

/**
 * The wallet a refusal names (`handoff-expiry:bark: …`), by its name as the cards say it, or undefined. The engine puts
 * its type between colons after the reason.
 */
export function handoffErrorWallet(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const type = message.match(/^handoff-[a-z-]+:([a-z]+):/)?.[1];
  return type && type in WALLET_NAME ? WALLET_NAME[type as keyof typeof WALLET_NAME] : undefined;
}

/** A date as people read it, in the app's language ("12 Oct 2026"): when coins expire. */
export function dayText(at: number, language: string): string {
  try { return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(at)); }
  catch { return new Date(at).toDateString(); }
}

/** A wallet type the engine names, as the cards say it. */
export const walletNameOf = (type: string | undefined): string => (type && type in WALLET_NAME ? WALLET_NAME[type as keyof typeof WALLET_NAME] : type ?? "");

/** The handoff on this device, read twice a second while `on`. */
export function useHandoffView(on = true): HandoffView | null {
  const [view, setView] = useState<HandoffView | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () => void engine.call("deviceHandoffView").then((next) => { if (live) setView(next); }, () => {});
    read();
    const timer = setInterval(read, 500);
    return () => { live = false; clearInterval(timer); };
  }, [on]);
  return view;
}

