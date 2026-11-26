import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { expiringFrom } from "../../lib/identities";
import { sharingLinks } from "./contactLinks";
import type { ChipLink } from "./IdentityActivity";

/*
 * A contact's proof changes its mark with the clock alone: verified, then expiring (its last days, `expiringSoon`),
 * then expired (`currentStatus`), while the engine's view of it stays `verified` and sends nothing at those times.
 * What draws a contact's identities works their state out from the clock when it draws, and draws only when what it
 * reads of the engine's state changes, so a mark stayed "expiring" and a face kept a proof's name long after the proof
 * ran out.
 *
 * One clock for all of them: one timer, to the next time any contact's proof crosses one of those lines, that every
 * reader listens to (a chat list holds a reader per row). It ticks at that time, then waits for the next one; it is
 * worked out again when the contacts' identities change, and when the page is back (a computer that slept past the
 * time runs no timer meanwhile). No proof that changes with the clock, no timer.
 */

/** setTimeout's longest wait (about 24.8 days): a longer one fires at once. A later time is waited for in steps. */
const MAX_WAIT = 2 ** 31 - 1;

/** The times (seconds) at which a contact's proof changes its mark by the clock alone, in order. */
function linesOf(chips: readonly ChipLink[]): number[] {
  const at = new Set<number>();
  for (const chip of chips) {
    for (const r of chip.identities?.received ?? []) {
      if (r.status !== "verified" && r.status !== "unconfirmed") continue;
      at.add(r.expiresAt);
      // An unconfirmed proof has no "expiring" mark (it shows as failed until it expires).
      if (r.status === "verified") at.add(expiringFrom({ issuedAt: r.verifiedAt, expiresAt: r.expiresAt }));
    }
  }
  return [...at].sort((a, b) => a - b);
}

const linesOfList = new WeakMap<readonly ChipLink[], number[]>();
const linesNow = (chips: readonly ChipLink[]) => {
  let lines = linesOfList.get(chips);
  if (!lines) linesOfList.set(chips, lines = linesOf(chips));
  return lines;
};

/** The first line at or after `ms`. */
function firstFrom(lines: readonly number[], ms: number): number | undefined {
  let lo = 0, hi = lines.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid] * 1000 < ms) lo = mid + 1; else hi = mid; }
  return lines[lo];
}

const listeners = new Set<() => void>();
let tick = 0;
let chips: readonly ChipLink[] | undefined;
/** When the clock last looked (ms): a line between then and now was crossed. */
let lookedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopEngine: (() => void) | undefined;

function look(): void {
  const lines = linesNow(chips ?? []);
  const nowMs = Date.now();
  const crossed = firstFrom(lines, lookedAt);
  lookedAt = nowMs;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  const next = firstFrom(lines, nowMs);
  // Just past the line: a proof is expiring once less than its window is left, not at the window's first moment.
  if (next !== undefined) timer = setTimeout(look, Math.min(MAX_WAIT, Math.max(0, Math.ceil(next * 1000 - nowMs) + 1)));
  if (crossed !== undefined && crossed * 1000 < nowMs) {
    tick++;
    for (const listener of [...listeners]) listener();
  }
}

/** On every engine state: looks again only when a contact's identities changed (the same list otherwise, contactLinks.ts). */
function onState(): void {
  const now = sharingLinks(engine.state?.links);
  if (now === chips) return;
  chips = now;
  look();
}

const onShown = () => { if (document.visibilityState !== "hidden") look(); };

function start(): void {
  chips = sharingLinks(engine.state?.links);
  lookedAt = Date.now();
  stopEngine = engine.subscribe(onState);
  document.addEventListener("visibilitychange", onShown);
  window.addEventListener("focus", look);
  window.addEventListener("pageshow", look);
  look();
}

function stop(): void {
  stopEngine?.();
  stopEngine = undefined;
  document.removeEventListener("visibilitychange", onShown);
  window.removeEventListener("focus", look);
  window.removeEventListener("pageshow", look);
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  chips = undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const snapshot = () => tick;

/**
 * A number that changes when a contact's proof crosses a line of its mark by the clock (it expires, or enters its
 * last days): what draws contacts' identities reads it, so it draws again then. One timer however many read it.
 */
export const useProofClock = (): number => useSyncExternalStore(subscribe, snapshot, snapshot);
