import { engine } from "@ghostly/browser/platform/engine";
import type { Translate } from "../contexts/I18nContext";

/*
 * The group's admin acts on a member in its call (WISP 602 § Moderation), through the engine (`groupCallModerate`),
 * which signs the request with the admin's member key and sends it to the group's node. The engine's method comes with
 * its own slice: until then it is typed here, and the cast goes once `EngineApi` carries it.
 */

/** What the admin can take from a member, and give back. `screen_share` covers the screen's sound too. */
export type GroupCallSource = "microphone" | "camera" | "screen_share";
export type GroupCallModerationAct = "mute" | "allow" | "remove" | "unban" | "state";

/** The room's state after an act: the sources taken from each key, and the keys removed from the call. */
export interface GroupCallRoomState {
  muted: Record<string, GroupCallSource[]>;
  banned: string[];
}

/**
 * Why nothing happened: not the admin, the node's refusal, too many at once, a node without the route, no answer; and,
 * told here and never by the node, a target the engine refuses because it is not another member's key (`not_member`).
 */
export type GroupCallModerationCode = "not_admin" | "not_member" | "refused" | "rate_limited" | "unsupported" | "unreachable";
export type GroupCallModerationResult = { ok: true; state: GroupCallRoomState } | { ok: false; code: GroupCallModerationCode; retryAfter?: number };

export interface GroupCallModeration {
  groupId: string;
  act: GroupCallModerationAct;
  target?: string;
  src?: GroupCallSource[];
}

/** The engine's throw for a target that is not another member's key (engine/node.ts `groupCallModerate`). */
const NOT_A_MEMBER_KEY = "target must be the key of another member";

/**
 * Sends one act. The engine's throw for a target that is not a member's key (a tile under another identity, as a
 * node-run participant's) is `not_member`; any other throw (the engine gone) reads as no answer.
 */
export async function moderateGroupCall(ask: GroupCallModeration): Promise<GroupCallModerationResult> {
  const call = engine.call as unknown as (method: "groupCallModerate", params: GroupCallModeration) => Promise<GroupCallModerationResult>;
  try {
    return await call.call(engine, "groupCallModerate", ask);
  } catch (cause) {
    return { ok: false, code: (cause as { message?: unknown } | null)?.message === NOT_A_MEMBER_KEY ? "not_member" : "unreachable" };
  }
}

/** The one line said when an act did nothing. */
export function moderationProblemText(code: GroupCallModerationCode, t: Translate): string {
  switch (code) {
    case "unsupported": return t("groupCallModeration.unsupported");
    case "rate_limited": return t("groupCallModeration.rateLimited");
    case "refused": return t("groupCallModeration.refused");
    case "not_admin": return t("errors.group.adminOnly");
    case "not_member": return t("groupCallModeration.notMember");
    default: return t("groupCallModeration.unreachable");
  }
}
