import { useCallback, useEffect, useRef, useState } from "react";
import { SCREEN_SHARE_ERROR_MS } from "@ghostly/react";
import { useI18n } from "../contexts/I18nContext";
import { moderateGroupCall, moderationProblemText, type GroupCallModerationAct, type GroupCallRoomState, type GroupCallSource } from "../lib/groupCallModeration";

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

const EMPTY: GroupCallRoomState = { muted: {}, banned: [] };

/**
 * The admin's side of a call (WISP 602 § Moderation): once in the room, the room's state is read once, so a source
 * taken earlier offers its Allow and a removed member its Let back in; each act's reply is the state after it. A line
 * said when an act did nothing goes after a few seconds. Null for anyone but the admin, who asks the node nothing.
 */
export function useCallModeration(moderator: GroupCallModerator | undefined, connected: boolean): CallModeration | null {
  const { t } = useI18n();
  const groupId = moderator?.groupId ?? null;
  const [state, setState] = useState<GroupCallRoomState>(EMPTY);
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
    let live = true;
    const n = ++asked.current;
    void moderateGroupCall({ groupId, act: "state" }).then((result) => { if (live && result.ok) take(n, result.state); });
    return () => { live = false; };
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
  return moderator ? { moderator, state, act, say, problem } : null;
}
