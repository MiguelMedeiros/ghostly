import { useCallback, useEffect, useRef, useState } from "react";
import { SCREEN_SHARE_ERROR_MS } from "@ghostly/react";
import { useI18n } from "../contexts/I18nContext";
import { moderateGroupCall, moderationProblemText, type GroupCallModerationAct, type GroupCallModerationResult, type GroupCallRoomState, type GroupCallSource } from "../lib/groupCallModeration";
import { OCCUPANCY_RETRY_AFTER_MS, occupancyBackoffMs } from "./useGroupCallOccupancy";

/** The group whose admin you are, and who in the call is one of its members (Remove from group is only for them). */
export interface GroupCallModerator {
  groupId: string;
  inGroup: (identity: string) => boolean;
}

/** What the admin's tiles share: the room's state as the node last said it, and the line said when an act did nothing. */
export interface CallModeration {
  moderator: GroupCallModerator;
  state: GroupCallRoomState;
  act: (act: GroupCallModerationAct, target: string, src?: GroupCallSource[]) => Promise<void>;
  say: (line: string) => void;
  problem: { line: string; id: number } | null;
}

/** What a tile already knows of a person, from the call's own permissions: what the admin took from them (`byAdmin`). */
export interface ModeratedPerson {
  identity: string;
  byAdmin?: { mic: boolean; camera: boolean; screen: boolean };
}

/**
 * The room's state as the tiles show it while the node has not said it yet: what the call's permissions say was taken
 * from each person in the room, as their marks show it. Who was removed is not in the room, so only the node can say.
 */
function stateFromTiles(people: readonly ModeratedPerson[]): GroupCallRoomState {
  const muted: Record<string, GroupCallSource[]> = {};
  for (const { identity, byAdmin } of people) {
    const taken = ([[byAdmin?.mic, "microphone"], [byAdmin?.camera, "camera"], [byAdmin?.screen, "screen_share"]] as const).filter(([on]) => on).map(([, src]) => src);
    if (taken.length) muted[identity] = taken;
  }
  return { muted, banned: [] };
}

/**
 * When to read the room's state again after a read that did nothing (WISP 602 § Occupancy's client rule): a 429 after
 * its Retry-After (a minute when it says none), no answer after the floor and twice as long each time in a row, up to
 * ten minutes. Null: not asked again while connected (the node has no route, refuses the admin, or I am not the admin).
 */
function stateRetryMs(result: Extract<GroupCallModerationResult, { ok: false }>, noAnswers: number): number | null {
  if (result.code === "rate_limited")
    return typeof result.retryAfter === "number" && Number.isFinite(result.retryAfter) && result.retryAfter >= 0 ? result.retryAfter * 1000 : OCCUPANCY_RETRY_AFTER_MS;
  if (result.code === "unreachable") return occupancyBackoffMs(noAnswers);
  return null;
}

/**
 * The admin's side of a call (WISP 602 § Moderation): once in the room, the room's state is read, so a source taken
 * earlier offers its Allow and a removed member its Let back in; each act's reply is the state after it. A read that
 * did nothing is asked again (`stateRetryMs`) until a state comes, by it or by an act's reply; meanwhile the menu
 * goes by what the tiles know (`others`' `byAdmin`). A line said when an act did nothing goes after a few seconds.
 * Null for anyone but the admin, who asks the node nothing.
 */
export function useCallModeration(moderator: GroupCallModerator | undefined, connected: boolean, others: readonly ModeratedPerson[] = []): CallModeration | null {
  const { t } = useI18n();
  const groupId = moderator?.groupId ?? null;
  const [state, setState] = useState<GroupCallRoomState | null>(null);
  const [problem, setProblem] = useState<{ line: string; id: number } | null>(null);
  const say = useCallback((line: string) => setProblem((was) => ({ line, id: (was?.id ?? 0) + 1 })), []);
  // Each ask is numbered: a reply older than the last one taken (the read on joining answering after a mute, two acts
  // whose replies cross) is the room before it, and would offer Mute again for a source already taken.
  const asked = useRef(0), taken = useRef(0);
  const take = useCallback((n: number, next: GroupCallRoomState) => {
    if (n <= taken.current) return;
    taken.current = n;
    setState(next);
  }, []);
  useEffect(() => {
    if (!groupId || !connected) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, noAnswers = 0;
    // A state taken after this point (this read's, or an act's reply) ends the retries.
    const since = taken.current;
    const read = () => {
      if (!live || taken.current > since) return;
      const n = ++asked.current;
      void moderateGroupCall({ groupId, act: "state" }).then((result) => {
        if (!live) return;
        if (result.ok) return take(n, result.state);
        if (taken.current > since) return;
        if (result.code === "unreachable") noAnswers += 1;
        const wait = stateRetryMs(result, noAnswers);
        if (wait !== null) timer = setTimeout(read, wait);
      });
    };
    read();
    return () => { live = false; clearTimeout(timer); };
  }, [groupId, connected, take]);
  useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => setProblem((was) => (was === problem ? null : was)), SCREEN_SHARE_ERROR_MS);
    return () => clearTimeout(timer);
  }, [problem]);
  const act = useCallback(async (act: GroupCallModerationAct, target: string, src?: GroupCallSource[]) => {
    if (!groupId) return;
    const n = ++asked.current;
    const result = await moderateGroupCall({ groupId, act, target, ...(src && { src }) });
    if (result.ok) take(n, result.state);
    else say(moderationProblemText(result.code, t));
  }, [groupId, say, t, take]);
  return moderator ? { moderator, state: state ?? stateFromTiles(others), act, say, problem } : null;
}
