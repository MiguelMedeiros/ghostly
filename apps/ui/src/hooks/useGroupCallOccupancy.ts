import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupCallOccupancyResult } from "@ghostly/browser/engine/groupCall";
import { usePageShown } from "./usePageShown";

/*
 * Whether a group's call is on before joining it (WISP 602 § Occupancy), asked through the engine
 * (`groupCallOccupancy`), which signs the request with my member key: while the group is open, the page shown, and I'm
 * not in its call. At most once per `OCCUPANCY_FLOOR_MS` for a group on this page, however often it is opened or shown
 * again: the node allows 30 a minute from one address, so a few tabs or devices behind one address still fit.
 *
 * No answer (an old node without the route, whose refused preflight reads as a network error; a 403, a 429, a node
 * away) says nothing about the call: the button shows as it would without the route, and the next ask waits twice as
 * long each time, from the floor up to `OCCUPANCY_BACKOFF_MAX_MS`, so a node that never answers is not asked every
 * 15 s for as long as the group stays open. A real answer brings it back to the floor. A 429's Retry-After is
 * waited out when it is longer.
 */

/** The shortest time between two asks about one group's call. */
export const OCCUPANCY_FLOOR_MS = 15_000;
/** The longest wait after asks that got no answer. */
export const OCCUPANCY_BACKOFF_MAX_MS = 10 * 60_000;

/** What the node said of the group's call: `count` members in it, since `since` (unix seconds) once one is. */
export interface GroupCallOccupancyNow {
  count: number;
  since?: number;
}

/** When each group's call was last asked about on this page, so opening it again within the floor waits the rest. */
const askedAt = new Map<string, number>();
/** Each group's last answer and when it came: opened again within the floor, the header shows it at once. */
const answers = new Map<string, { occupancy: GroupCallOccupancyNow; at: number }>();

/** The wait after `failures` asks in a row that got no answer: the floor, doubled for each one after the first. */
export function occupancyBackoffMs(failures: number): number {
  return Math.min(OCCUPANCY_FLOOR_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), OCCUPANCY_BACKOFF_MAX_MS);
}

function freshAnswer(groupId: string): GroupCallOccupancyNow | null {
  const kept = answers.get(groupId);
  return kept && Date.now() - kept.at < OCCUPANCY_FLOOR_MS ? kept.occupancy : null;
}

/**
 * The group's call as its node last told it: null while not known (not asked yet, no answer, or not `enabled`).
 * `enabled`: false while I'm in the call, where the button shows the call itself, or where this app can't join one.
 */
export function useGroupCallOccupancy(groupId: string, enabled: boolean): GroupCallOccupancyNow | null {
  const shown = usePageShown();
  const [known, setKnown] = useState<{ groupId: string; occupancy: GroupCallOccupancyNow | null }>(() => ({ groupId, occupancy: freshAnswer(groupId) }));
  /** Asks in a row with no answer, and the time before which none goes out, for the group open: hiding the page keeps them. */
  const backoff = useRef({ groupId, failures: 0, until: 0 });

  useEffect(() => {
    if (backoff.current.groupId !== groupId) backoff.current = { groupId, failures: 0, until: 0 };
    if (!enabled || !shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const plan = () => {
      const at = Math.max((askedAt.get(groupId) ?? -Infinity) + OCCUPANCY_FLOOR_MS, backoff.current.until);
      const wait = at - Date.now();
      if (wait <= 0) void ask();
      else timer = setTimeout(() => void ask(), wait);
    };
    const ask = async () => {
      askedAt.set(groupId, Date.now());
      let result: GroupCallOccupancyResult | null = null;
      try {
        result = await engine.call("groupCallOccupancy", { groupId });
      } catch {
        // An engine without the call, or one gone away: not known, as any other no-answer.
      }
      if (!live) return;
      const state = backoff.current;
      if (result?.ok) {
        const occupancy: GroupCallOccupancyNow = { count: result.count, ...(result.since !== undefined && { since: result.since }) };
        answers.set(groupId, { occupancy, at: Date.now() });
        state.failures = 0;
        state.until = 0;
        setKnown({ groupId, occupancy });
      } else {
        answers.delete(groupId);
        state.failures += 1;
        const retryAfter = result && !result.ok && result.code === "rate_limited" ? (result.retryAfter ?? 0) * 1000 : 0;
        state.until = Date.now() + Math.max(occupancyBackoffMs(state.failures), retryAfter);
        setKnown({ groupId, occupancy: null });
      }
      plan();
    };
    plan();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [groupId, enabled, shown]);

  return enabled && known.groupId === groupId ? known.occupancy : null;
}
