import { useEffect } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { LinkView } from "@ghostly/browser/shared/types";

/**
 * The wait after a dial of the chat on screen that did not go live, doubling from this to `REDIAL_MAX_MS`: the pace
 * WISP 100 sets for a chat's automatic dials ("Background retry", 20 s doubling to 3 min).
 */
export const REDIAL_FIRST_MS = 20_000;
export const REDIAL_MAX_MS = 3 * 60_000;
/** Two dials never go closer than this, whatever brings them (the window shown and hidden again quickly). */
export const REDIAL_MIN_GAP_MS = 5_000;
/**
 * After a live link closed: the contact's app is the one that dials it again at once (it has the lower key), and it
 * may have chosen DHT only, which this side reads from its envelope in about 10 s. Its dial comes first.
 */
export const REDIAL_AFTER_DROP_MS = 15_000;

/** What `redialView` reads of the chat on screen: whether a dial is due now, and not before when. */
export interface RedialView {
  /** This app would dial the chat now, on the person's behalf: it is not live and nothing else dials it. */
  due: boolean;
  /** Live: the dials so far are over, and a drop later starts them again from the first wait. */
  live: boolean;
  /** The contact's app is seen (its packet is fresh). */
  seen: boolean;
  /** Not before this time (a live link that closed just now). */
  notBefore: number;
}

const NONE: RedialView = { due: false, live: false, seen: false, notBefore: 0 };

/** When the chat's last live link closed, if nothing was live since. */
function closedAt(link: LinkView): number {
  const history = link.transportHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i]!;
    if (e.kind === "live") return 0;
    if (e.kind === "down") return e.restart ? 0 : e.at;
  }
  return 0;
}

/**
 * Whether the chat `linkId` waits for a dial only a person's Reconnect would make. The engine dials a chat by itself
 * from the side with the lower key; the other side only republishes its presence and waits for the contact's app,
 * which reads it at its own pace (minutes, in the background) and after its own wait between failed attempts. That
 * side is the one this covers: a paired chat, its contact pinned and seen, not live, nothing on its way (an offer
 * out or being answered), not DHT only on either side, not in its first pairing (which has a pace of its own), and
 * with a transport this app can run. Ghostly online.
 */
export function redialView(state: typeof engine.state, linkId: string): RedialView {
  const link = state?.links.find((l) => l.id === linkId);
  if (!link || link.profile !== "paired-chat/1" || !link.peerParticipationKey) return NONE;
  const pair = link.pairing;
  const live = pair?.status === "ready" && link.dataLink === "open" && !!pair.transport;
  const seen = link.peerOnline;
  const view = { live, seen, notBefore: 0 };
  if (live || state?.settings.online === false) return { ...view, due: false };
  const progress = link.pairingProgress?.stage;
  const pairing = !!progress && progress !== "live" && progress !== "on-dht" && progress !== "failed";
  const due = seen && link.liveDialer === "contact" && link.dataLink === "idle" && !pairing
    && pair?.status !== "confirm" && pair?.status !== "waiting" && !pair?.transitionTarget
    && link.deliveryMode !== "dht" && link.dhtDelivery?.peerMode !== "dht"
    && !(state?.settings.relayOnly === true && link.runnableTransports?.length === 0);
  const closed = closedAt(link);
  return { ...view, due, notBefore: closed ? closed + REDIAL_AFTER_DROP_MS : 0 };
}

/** The wait after `failures` dials in a row that did not go live. */
export const redialWait = (failures: number) => failures <= 0 ? 0 : Math.min(REDIAL_FIRST_MS * 2 ** (failures - 1), REDIAL_MAX_MS);

/**
 * The chat on screen that is not live keeps trying to go live by itself, so nobody has to open its connection panel
 * and press Reconnect: the dial Reconnect makes goes as the chat opens, again after each wait while it stays open and
 * in sight (`REDIAL_FIRST_MS` doubling to `REDIAL_MAX_MS`), and at once when the page shows again or the device is back
 * online. Only while the chat waits for a dial nothing else makes (`redialView`): the side that dials on its own
 * already does all of this in the engine. Never while the page is hidden or the device offline; over once the chat is
 * live or closed. One dial at a time: the next waits for the last to settle (the engine gives one up to 90 s).
 * `linkId`: the 1:1 chat on screen, or none.
 */
export function useChatRedial(linkId: string | null): void {
  useEffect(() => {
    if (!linkId) return;
    let failures = 0, lastAt = 0, inFlight = false, stopped = false, wasSeen = true;
    let timer: ReturnType<typeof setTimeout> | undefined, timerAt = 0;
    const inSight = () => document.visibilityState === "visible" && navigator.onLine !== false;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    // When the next dial may go, by the wait, the gap between dials and a drop just now.
    const nextAt = (view: RedialView) => Math.max(lastAt + Math.max(redialWait(failures), lastAt ? REDIAL_MIN_GAP_MS : 0), view.notBefore);
    const consider = () => {
      if (stopped) return;
      const view = redialView(engine.state, linkId);
      if (view.live) failures = 0;
      // The contact seen again after it was not: its app is back, the wait starts over (WISP 100).
      if (view.seen && !wasSeen) failures = 0;
      wasSeen = view.seen;
      if (!view.due || inFlight || !inSight()) { clear(); return; }
      // Read again on every change of the engine's state (many a second while a file moves): set anew only when the
      // time moved (the wait started over, a drop just now).
      const at = nextAt(view);
      if (timer !== undefined && timerAt === at) return;
      clear();
      timerAt = at;
      timer = setTimeout(dial, Math.max(0, at - Date.now()));
    };
    const dial = () => {
      timer = undefined;
      if (stopped || inFlight || !inSight()) return;
      const view = redialView(engine.state, linkId);
      if (!view.due) return;
      if (Date.now() < nextAt(view)) { consider(); return; }
      inFlight = true;
      failures++;
      void engine.call("connect", { linkId }).catch(() => {}).finally(() => {
        inFlight = false;
        lastAt = Date.now();
        consider();
      });
    };
    // Back in sight, or back online: the wait starts over and the chat is dialled now, as Reconnect would.
    const fresh = () => {
      if (!inSight()) { clear(); return; }
      failures = 0;
      clear();
      consider();
    };
    const unsubscribe = engine.subscribe(consider);
    document.addEventListener("visibilitychange", fresh);
    window.addEventListener("online", fresh);
    window.addEventListener("offline", consider);
    consider();
    return () => {
      stopped = true;
      clear();
      unsubscribe();
      document.removeEventListener("visibilitychange", fresh);
      window.removeEventListener("online", fresh);
      window.removeEventListener("offline", consider);
    };
  }, [linkId]);
}
