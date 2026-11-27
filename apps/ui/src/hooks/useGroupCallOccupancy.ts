import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupCallOccupancyResult } from "@ghostly/browser/engine/groupCall";
import { useWindowAway } from "../lib/windowAway";

/*
 * Whether a group's call is on before joining it (WISP 602 § Occupancy), asked through the engine
 * (`groupCallOccupancy`), which signs the request with my member key: while the group is open, in sight (the page
 * shown and its window the focused one: a hidden tab or a window in the background asks nothing) and I'm not in its
 * call. At most once per `OCCUPANCY_FLOOR_MS` for a group on this page, however often it is opened or shown again.
 *
 * Anything but a 200 says nothing about the call: the button shows as it would without the route. What comes next
 * depends on what came back, kept per call node (its origin) for as long as the app runs, so coming back to the group
 * never cuts a wait short:
 * - `refused` (a 403, a key banned from the call too): asked again at the floor, as after a 200.
 * - `unsupported` (a 404 or a 405: a node without the route, or no node named): that node is not asked again until the
 *   group's call names another node or the app starts again.
 * - `rate_limited` (a 429): its Retry-After is waited out, `OCCUPANCY_RETRY_AFTER_MS` when it could not be read.
 * - `unreachable` (no answer at all: an old node refusing the preflight, a node away; or an engine error): each one
 *   in a row waits twice as long, from the floor up to `OCCUPANCY_BACKOFF_MAX_MS`; a 200 brings it back to the floor.
 * - `not_member` (told by the engine itself, nothing sent): not asked again while the group stays open.
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
/** Each group's last answer and when it came: opened again within the floor, the header shows it at once. */
const answers = new Map<string, { occupancy: GroupCallOccupancyNow; at: number }>();
/** The call node each group was last seen naming, so a change of node is told. */
const groupNodes = new Map<string, string>();

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

/** The wait a 429 asks for: its Retry-After in seconds, or `OCCUPANCY_RETRY_AFTER_MS` when it has none readable. */
function retryAfterMs(seconds: number | undefined): number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : OCCUPANCY_RETRY_AFTER_MS;
}

function freshAnswer(groupId: string): GroupCallOccupancyNow | null {
  const kept = answers.get(groupId);
  return kept && Date.now() - kept.at < OCCUPANCY_FLOOR_MS ? kept.occupancy : null;
}

/**
 * The group's call as its node last told it: null while not known (not asked yet, anything but a 200, or not
 * `enabled`). `sfu`: the node the group's `call` names. `enabled`: false while I'm in the call, where the button shows
 * the call itself, or where this app can't join one.
 */
export function useGroupCallOccupancy(groupId: string, sfu: string | undefined, enabled: boolean): GroupCallOccupancyNow | null {
  const away = useWindowAway();
  const node = nodeOf(sfu);
  const key = `${groupId} ${node}`;
  const [known, setKnown] = useState<{ key: string; occupancy: GroupCallOccupancyNow | null }>(() => ({ key, occupancy: freshAnswer(groupId) }));
  /** The group and node the engine said I'm not a member of, while open: asked again only once opened again. */
  const outside = useRef<string | null>(null);

  useEffect(() => {
    // The group's call names another node: that one is asked at once, even one that once had no route.
    const before = groupNodes.get(groupId);
    groupNodes.set(groupId, node);
    if (before !== undefined && before !== node) {
      nodeAsks(node).unsupported = false;
      askedAt.delete(groupId);
      answers.delete(groupId);
    }
    if (!enabled || away) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Read again at each turn: another group on the same node may have learnt a wait, or that it has no route.
    const plan = () => {
      const asks = nodeAsks(node);
      if (asks.unsupported || outside.current === key) return;
      const wait = Math.max((askedAt.get(groupId) ?? -Infinity) + OCCUPANCY_FLOOR_MS, asks.until) - Date.now();
      if (wait <= 0) void ask();
      else timer = setTimeout(plan, wait);
    };
    const ask = async () => {
      askedAt.set(groupId, Date.now());
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
        answers.set(groupId, { occupancy, at: Date.now() });
        asks.failures = 0;
        asks.until = 0;
      } else {
        answers.delete(groupId);
        const code = result?.code ?? "unreachable";
        if (code === "unsupported") asks.unsupported = true;
        else if (code === "rate_limited") asks.until = Date.now() + retryAfterMs(result?.retryAfter);
        else if (code === "not_member") outside.current = key;
        else if (code !== "refused") {
          asks.failures += 1;
          asks.until = Date.now() + occupancyBackoffMs(asks.failures);
        }
      }
      if (!live) return;
      setKnown({ key, occupancy });
      plan();
    };
    plan();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [groupId, node, key, enabled, away]);

  return enabled && known.key === key ? known.occupancy : null;
}
