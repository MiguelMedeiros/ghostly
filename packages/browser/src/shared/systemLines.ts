import { isJoinNotice } from "./edits";
import { paymentRefusal } from "./refusals";
import type { StoredMessage } from "./types";

/*
 * The chat rows the pages draw as the app's own lines, not as messages (`toChatMessage`, platform/sync.ts): the chat's
 * joined line and a refused payment's line. The engine's chat search (engine/chatSearch.ts) leaves them out, as the
 * pages' search does (apps/ui lib/chatSearch `searchText`), so both find a chat by the same messages.
 */

/**
 * Whether a row is the chat's joined line, drawn as the app's own line: the contact's only when the engine took it as
 * one (`joinLine`, their first row of the chat), any other row of theirs in those words being a message; mine by its words.
 */
export const isJoinLine = (message: Pick<StoredMessage, "text" | "sender" | "joinLine">): boolean =>
  isJoinNotice(message.text) && (message.sender === "me" || !!message.joinLine);

/** Whether the pages draw a row as the app's own line (`toChatMessage`): a joined line, or a refused payment's line. */
export const isSystemLine = (message: StoredMessage): boolean => isJoinLine(message) || !!paymentRefusal(message);
