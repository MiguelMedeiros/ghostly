import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupCallOccupancyResult } from "@ghostly/browser/engine/groupCall";
import { useEngineValue } from "../lib/engineState";
import { useWindowAway } from "../lib/windowAway";

/*
 * Whether a group's call is on before joining it (WISP 602 § Occupancy), asked through the engine
 * (`groupCallOccupancy`), which signs the request with my member key: while the group is open, in sight (the page
 * shown and its window the focused one: a hidden tab or a window in the background asks nothing) and I'm not in its
 * call. At most once per `OCCUPANCY_FLOOR_MS` for a group on this page, however often it is opened or shown again.
 * An answer that comes after the window went away and back, or after a change of the call or of "Hide my IP", is
 * still shown while the group is open, for the same node and call and with "Hide my IP" off.
 *
 * Anything but a 200 says nothing about the call: the button shows as it would without the route. What comes next
 * depends on what came back, kept per call node (its origin) for as long as the app runs, so coming back to the group
 * never cuts a wait short:
 * - `refused` (a 403, a key banned from the call too) and `bad_reply` (any other status, or a 200 that is not an
 *   occupancy: the node answered, only not usefully): asked again at the floor, as after a 200. Only a 200 ends a
 *   backoff, as the WISP says.
 * - `unsupported` (a 404 or a 405: a node without the route, or no node named; the engine remembers it too, per
 *   group, until the group's `call` changes): that node is not asked again until the group's `call` changes in any
 *   way (the engine forgets it then, so this does too) or the app starts again.
 * - `rate_limited` (a 429): its `retryAfter` is waited out, `OCCUPANCY_RETRY_AFTER_MS` when it is null (none the
 *   page could read).
 * - `no_answer` (no status at all: an old node refusing the preflight, a node away, the timeout; an engine error the
 *   same): the first one waits the floor, and each one in a row after it twice as long as the last, up to
 *   `OCCUPANCY_BACKOFF_MAX_MS`; a 200 brings it back to the floor.
 * - `not_member` (told by the engine itself, nothing sent): not asked again while the group stays open.
 * - `hidden` (told by the engine itself, nothing sent: "Hide my IP" is on, and asking would show the node my address
 *   without my say): no group is asked again while that setting stays as it was; once it changes, asked as before.
 */

/** The shortest time between two asks about one group's call. */
export const OCCUPANCY_FLOOR_MS = 15_000;
/** The longest wait after asks that got no answer. */
export const OCCUPANCY_BACKOFF_MAX_MS = 10 * 60_000;
/** The wait after a 429 whose Retry-After could not be read. */
export const OCCUPANCY_RETRY_AFTER_MS = 60_000;

/** What the node said of the group's call: `count` members in it, since `since` (unix seconds) once one is. */
export interface GroupCallOccupancyNow {
  count: number;
  since?: number;
}

/** When each group's call was last asked about on this page, so opening it again within the floor waits the rest. */
const askedAt = new Map<string, number>();
/** Each group's last answer, when it came and for which `call`: opened again within the floor, the header shows it at once. */
const answers = new Map<string, { occupancy: GroupCallOccupancyNow; at: number; stamp: string }>();
/** The `call` each group was last seen with, so a change of it is told. */
const groupCalls = new Map<string, string>();
/**
 * The "Hide my IP" setting (`relayOnly`) as it was when the engine said `hidden`; null while it has not. While the
 * setting stays so, nothing is asked: the engine would send nothing anyway.
 */
let hiddenUnder: boolean | null = null;

/**
 * Per call node (its origin): asks in a row with no answer, the time before which it is not asked again (a backoff
 * or a Retry-After), and whether it answered that it has no route.
 */
interface NodeAsks { failures: number; until: number; unsupported: boolean }
const nodes = new Map<string, NodeAsks>();

function nodeAsks(node: string): NodeAsks {
  let asks = nodes.get(node);
  if (!asks) nodes.set(node, (asks = { failures: 0, until: 0, unsupported: false }));
  return asks;
}

/** The node a group's `call.sfu` names, by its origin; "" for none (the engine answers `unsupported` for it). */
function nodeOf(sfu: string | undefined): string {
  if (!sfu) return "";
  try { return new URL(sfu).origin; } catch { return sfu; }
}

/** The wait after `failures` asks in a row that got no answer: the floor, doubled for each one after the first. */
export function occupancyBackoffMs(failures: number): number {
  return Math.min(OCCUPANCY_FLOOR_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), OCCUPANCY_BACKOFF_MAX_MS);
}

/** The wait a 429 asks for: its `retryAfter` in seconds, or `OCCUPANCY_RETRY_AFTER_MS` when it is null (none readable). */
function retryAfterMs(seconds: number | null | undefined): number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : OCCUPANCY_RETRY_AFTER_MS;
}

/** The group's last answer while within the floor, and only for the `call` it has now (not another node's). */
function freshAnswer(groupId: string, stamp: string): GroupCallOccupancyNow | null {
  const kept = answers.get(groupId);
  return kept && kept.stamp === stamp && Date.now() - kept.at < OCCUPANCY_FLOOR_MS ? kept.occupancy : null;
}

/**
 * The group's call as its node last told it: null while not known (not asked yet, anything but a 200, or not
 * `enabled`). `call`: the group's `call` (the node it names, and whether it is sealed). `enabled`: false while I'm in
 * the call, where the button shows the call itself, or where this app can't join one.
 */
export function useGroupCallOccupancy(groupId: string, call: { sfu: string; e2ee?: 1 } | undefined, enabled: boolean): GroupCallOccupancyNow | null {
  const away = useWindowAway();
  const relayOnly = useEngineValue((state) => state?.settings.relayOnly === true);
  const node = nodeOf(call?.sfu);
  const stamp = JSON.stringify(call ?? null);
  const key = `${groupId} ${node}`;
  const [known, setKnown] = useState<{ key: string; occupancy: GroupCallOccupancyNow | null }>(() => ({ key, occupancy: freshAnswer(groupId, stamp) }));
  /** The group and node the engine said I'm not a member of, while open: asked again only once opened again. */
  const outside = useRef<string | null>(null);
  /** "Hide my IP" as it is now, for an answer that comes after it changed. */
  const relayOnlyNow = useRef(relayOnly);
  relayOnlyNow.current = relayOnly;
  /** The button's call as it is now, whether it is still shown, and its last ask: for an answer that comes late. */
  const now = useRef({ key, stamp, mounted: false, lastAsk: 0 });
  now.current.key = key;
  now.current.stamp = stamp;
  useEffect(() => {
    const mine = now.current;
    mine.mounted = true;
    return () => { mine.mounted = false; };
  }, []);

  useEffect(() => {
    // The group's call changed (another node, or the same one sealed or not): asked at once, even a node that once
    // had no route, as the engine forgets that too.
    const before = groupCalls.get(groupId);
    groupCalls.set(groupId, stamp);
    if (before !== undefined && before !== stamp) {
      nodeAsks(node).unsupported = false;
      askedAt.delete(groupId);
      answers.delete(groupId);
    }
    // "Hide my IP" changed since the engine said `hidden`: asked as before.
    if (hiddenUnder !== null && hiddenUnder !== relayOnly) hiddenUnder = null;
    if (!enabled || away) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Read again at each turn: another group on the same node may have learnt a wait, or that it has no route.
    const plan = () => {
      const asks = nodeAsks(node);
      if (asks.unsupported || outside.current === key || hiddenUnder !== null) return;
      const wait = Math.max((askedAt.get(groupId) ?? -Infinity) + OCCUPANCY_FLOOR_MS, asks.until) - Date.now();
      if (wait <= 0) void ask();
      else timer = setTimeout(plan, wait);
    };
    const ask = async () => {
      askedAt.set(groupId, Date.now());
      const mine = ++now.current.lastAsk;
      let result: GroupCallOccupancyResult | null = null;
      try {
        result = await engine.call("groupCallOccupancy", { groupId });
      } catch {
        // An engine without the call, or one gone away: no answer, as a node away.
      }
      // Kept for the node even when the group closed meanwhile: opened again, it waits as it would have.
      const asks = nodeAsks(node);
      let occupancy: GroupCallOccupancyNow | null = null;
      if (result?.ok) {
        occupancy = { count: result.count, ...(result.since !== undefined && { since: result.since }) };
        answers.set(groupId, { occupancy, at: Date.now(), stamp });
        asks.failures = 0;
        asks.until = 0;
      } else {
        answers.delete(groupId);
        const code = result?.code ?? "no_answer";
        if (code === "unsupported") asks.unsupported = true;
        else if (code === "rate_limited") asks.until = Date.now() + retryAfterMs(result && "retryAfter" in result ? result.retryAfter : null);
        else if (code === "not_member") outside.current = key;
        else if (code === "hidden") hiddenUnder = relayOnlyNow.current;
        else if (code === "no_answer") {
          asks.failures += 1;
          asks.until = Date.now() + occupancyBackoffMs(asks.failures);
        }
        // `refused`, `bad_reply` and a code this page does not know: the floor, as after a 200.
      }
      if (live) {
        setKnown({ key, occupancy });
        plan();
        return;
      }
      // Late: the effect ran again while this was asked (the window went away and back, "Hide my IP" or the group's
      // call changed), and its next turn waits the floor from this ask. Still shown while the button is, for the same
      // node and call, if no ask came after it and "Hide my IP" is off.
      const shown = now.current;
      if (shown.mounted && shown.lastAsk === mine && shown.key === key && shown.stamp === stamp && !relayOnlyNow.current && hiddenUnder === null) {
        setKnown({ key, occupancy });
      }
    };
    plan();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [groupId, node, stamp, key, enabled, away, relayOnly]);

  return enabled && known.key === key ? known.occupancy : null;
}
