import { fromBase64Url, parseEngineError } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import type { Translate } from "../contexts/I18nContext";
import { rawError } from "./errorText";
import type { Problem } from "./problemText";
import { NO_CALL_KEY, NO_SEALING } from "../hooks/useGroupCall";

/*
 * A group call's pass from the group's node (WISP 602 § The reply), asked through the engine (`groupCallToken`), which
 * signs the request with the member's key. The engine's method and the group's `call` field come with the engine's
 * slice: until then they are typed here, and these two casts go once `EngineApi` and `GroupView` carry them.
 */

/** The node's reply, as the engine hands it on. */
export interface GroupCallPass {
  url: string;
  token: string;
  room: string;
  identity: string;
  /** Seconds the token stays valid for joining, at most 3600. */
  expiresIn: number;
  iceServers?: RTCIceServer[];
}

/** The group's call, as its admin signed it in the metadata (WISP 602 § The group names its node). */
export interface GroupCallField {
  sfu: string;
  /** 1: the group's call media is sealed end to end (WISP 602 § End-to-end encryption); anything else is off. */
  e2ee?: 1;
}

/** The group's call, when it has one: only a group the admin gave a call node shows Join call. */
export function groupCallOf(group: GroupView): GroupCallField | undefined {
  return (group as GroupView & { call?: GroupCallField }).call;
}

/** Asks the group's node for a pass. */
export function askGroupCallPass(groupId: string): Promise<GroupCallPass> {
  const call = engine.call as unknown as (method: "groupCallToken", params: { groupId: string }) => Promise<GroupCallPass>;
  return call.call(engine, "groupCallToken", { groupId });
}

/** Whether the group's call asks for sealed media: then no app joins it unsealed (WISP 602 § End-to-end encryption). */
export const groupCallSealed = (group: GroupView): boolean => groupCallOf(group)?.e2ee === 1;

/**
 * Whether this browser can seal call media, as livekit-client's `isE2EESupported` reads it (Insertable Streams or
 * RTCRtpScriptTransform), without loading livekit-client: the button reads it before any join.
 */
export function canSealCallMedia(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { RTCRtpScriptTransform?: unknown; RTCRtpSender?: { prototype: { createEncodedStreams?: unknown } } };
  return typeof w.RTCRtpScriptTransform !== "undefined" || typeof w.RTCRtpSender?.prototype.createEncodedStreams !== "undefined";
}

/** The group's call key for its newest epoch, from the engine (`groupCallKey`), as bytes; null while it isn't here. */
export async function askGroupCallKey(groupId: string): Promise<{ epoch: number; key: Uint8Array } | null> {
  const sealed = await engine.call("groupCallKey", { groupId });
  return sealed ? { epoch: sealed.epoch, key: fromBase64Url(sealed.key) } : null;
}

/** Asked again this long before a pass runs out. */
export const PASS_REFRESH_LEAD_S = 60;

/** When to ask for the next pass: a minute before this one runs out, or at four fifths of a short one. */
export function passRefreshInMs(expiresIn: number): number {
  return Math.max(1, expiresIn - PASS_REFRESH_LEAD_S, expiresIn * 0.8) * 1000;
}

/** The node's refusal (its one `403`, WISP 602 § What the node checks): the member is not on its roster yet. */
const REFUSED = [/\b403\b/, /\bforbidden\b/i, /\bnot let in\b/i];
/** The engine's own words for it: the node did not let this member in, or this device is not in the group. */
const REFUSED_CODES = new Set(["groupCallRefused", "groupCallNotMember"]);

/**
 * Why the call did not start: the node refused the pass (not on its roster yet, as a member just let in is), or the
 * node or its room could not be reached. The engine's English goes behind the ⓘ.
 */
export function groupCallProblem(cause: unknown, t: Translate): Problem {
  const detail = rawError(cause) || undefined;
  // A string: the engine's group-call codes come with its token slice, and until then no text parses to them.
  const code: string | undefined = detail ? parseEngineError(detail)?.code : undefined;
  const refused = REFUSED_CODES.has(code ?? "") || (!!detail && REFUSED.some((r) => r.test(detail)));
  return { tone: "error", title: t(refused ? "calls.group.refused" : "calls.group.unreachable"), ...(detail && { detail }) };
}

/** Why a sealed call was not joined, when it was for its seal (`useGroupCall`): no way to seal here, or no key yet. */
export function groupCallSealProblem(message: string | undefined, t: Translate): Problem | null {
  if (message === NO_SEALING) return { tone: "error", title: t("calls.group.noSealing"), info: t("calls.group.noSealingInfo") };
  if (message === NO_CALL_KEY) return { tone: "error", title: t("calls.group.noCallKey"), info: t("calls.group.noCallKeyInfo") };
  return null;
}
