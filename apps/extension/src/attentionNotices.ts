import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import { attentionOutcome, chatOfLink, mutedFor } from "../../ui/src/lib/chatMute";
import type { NotificationSettings } from "../../ui/src/lib/settings";
import { getPrefix } from "../../ui/src/lib/storage";
import { profileWords } from "./viewerWords";
import type { RuntimeMessage } from "./messages";

/*
 * The peer runs with no Ghostly tab open (docs/BROWSER.md), and only a tab's AttentionFeedback told the person of a new
 * message: one that came with every tab closed showed nothing until Ghostly was opened. The engine hands the peer what
 * no tab heard (`EngineServer.unheardAttention`), and the peer says it as a tab would have: the same generic words, under
 * the same rules (Settings → Notifications, a muted chat, a mention through a group's mute), with no chat open and no tab
 * in sight. Only the worker has `chrome.notifications`: the peer asks it to show one (background.ts `showNotice`). Loaded
 * by the peer (offscreen.ts) only when that happens, so its start carries no dictionary.
 */

/** As AttentionFeedback: an event older than this is a replay, not news. */
const LIVE_MS = 5000;

/**
 * Tells the person of an event no tab heard, when a tab would have shown a notification for it. `chatView`: the view of
 * the one 1:1 chat an event that may be shown is about (`GhostlyNode.chatView`), not the engine's whole state, which
 * builds every chat's and group's (3.7 ms at 300 chats, for each message of a burst).
 */
export async function noticeUnheard(event: AttentionEvent, chatView: (linkId: string) => { id: string; peerPubKeyZ32: string } | undefined): Promise<void> {
  if (Date.now() - event.at > LIVE_MS) return;
  const settings = notificationSettings();
  // Muted or not: nothing a muted chat shows is shown when it is not.
  if (!attentionOutcome(event.type, false, settings, true).notice) return;
  const view = event.linkId && !event.linkId.startsWith("group:") ? chatView(event.linkId) : undefined;
  const chat = chatOfLink(event.linkId, view ? [view] : []);
  if (!attentionOutcome(event.type, mutedFor(chat, !!event.mention), settings, true).notice) return;
  const { t } = await profileWords();
  const body = event.type === "reaction" ? t("chat.reactions.notice") : t("settings.privateNotice");
  await chrome.runtime.sendMessage({ target: "background", type: "notify", body, ...(chat ? { chat } : {}) } satisfies RuntimeMessage);
}

/**
 * The profile's notification switches, as its pages keep them (settings.ts), read only: a profile with no settings yet
 * has its system notifications off, as `loadSettings` starts one.
 */
function notificationSettings(): NotificationSettings {
  try {
    const kept = (JSON.parse(localStorage.getItem(`${getPrefix()}app_settings`) ?? "{}") as { notifications?: Partial<NotificationSettings> }).notifications;
    return { soundEnabled: kept?.soundEnabled !== false, systemEnabled: kept?.systemEnabled === true };
  } catch {
    return { soundEnabled: true, systemEnabled: false };
  }
}
