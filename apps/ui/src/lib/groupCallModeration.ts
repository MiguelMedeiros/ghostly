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

/** Why nothing happened: not the admin, the node's refusal, too many at once, a node without the route, no answer. */
export type GroupCallModerationCode = "not_admin" | "refused" | "rate_limited" | "unsupported" | "unreachable";
export type GroupCallModerationResult = { ok: true; state: GroupCallRoomState } | { ok: false; code: GroupCallModerationCode; retryAfter?: number };

export interface GroupCallModeration {
  groupId: string;
  act: GroupCallModerationAct;
  target?: string;
  src?: GroupCallSource[];
}

/** Sends one act. A throw (a request the engine refuses to sign, the engine gone) reads as no answer. */
export async function moderateGroupCall(ask: GroupCallModeration): Promise<GroupCallModerationResult> {
  const call = engine.call as unknown as (method: "groupCallModerate", params: GroupCallModeration) => Promise<GroupCallModerationResult>;
  try {
    return await call.call(engine, "groupCallModerate", ask);
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

/** The one line said when an act did nothing. */
export function moderationProblemText(code: GroupCallModerationCode, t: Translate): string {
  switch (code) {
    case "unsupported": return t("groupCallModeration.unsupported");
    case "rate_limited": return t("groupCallModeration.rateLimited");
    case "refused":
    case "not_admin": return t("groupCallModeration.refused");
    default: return t("groupCallModeration.unreachable");
  }
}
