import type { Translate } from "../locales/translate";
import type { CallEventType } from "./types";

/**
 * The id of a call's line in the history. With `call` (the time of the offer it rang with, for its ring and its miss),
 * the same each time: the history keeps one message per id, so an offer heard again after the app reopened while it
 * rang adds no second "Incoming video call".
 */
export function callLineId(type: CallEventType, call?: number): string {
  if (call !== undefined) return `system_call_${type}_${call}`;
  return `system_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A call's line, in the person's language: the history keeps it in English (Chat.tsx `addCallEventMessage`), with its
 * kind beside it. The timeline (MessageBubble) and the chat list's last line say it the same way.
 */
export function callEventText(t: Translate, type: CallEventType, hasVideo?: boolean): string | undefined {
  switch (type) {
    case "call_started": return hasVideo ? t("calls.timeline.videoStarted") : t("calls.timeline.audioStarted");
    case "call_received": return hasVideo ? t("calls.timeline.videoIncoming") : t("calls.timeline.audioIncoming");
    case "call_connected": return hasVideo ? t("calls.timeline.videoConnected") : t("calls.timeline.audioConnected");
    case "call_ended": return hasVideo ? t("calls.timeline.videoEnded") : t("calls.timeline.audioEnded");
    case "call_missed": return hasVideo ? t("calls.timeline.videoMissed") : t("calls.timeline.audioMissed");
    case "call_rejected": return hasVideo ? t("calls.timeline.videoDeclined") : t("calls.timeline.audioDeclined");
    case "call_failed": return hasVideo ? t("calls.timeline.videoFailed") : t("calls.timeline.audioFailed");
    // A kind this version does not know: its stored line as written.
    default: return undefined;
  }
}
