import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import { attentionOutcome, callRings, chatOfLink, mutedFor } from "../../ui/src/lib/chatMute";
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
 * How long a contact's call rings, as the app's `RING_MS` (@ghostly/react, which this document does not load): a ring
 * nobody answered is over by then in a tab too, and its notification goes.
 */
export const CALL_RING_MS = 60_000;

/** Per chat link, the notification of its call ringing with no tab open: its id, its showing, and the end of its ring. */
const rings = new Map<string, { id: string; shown: Promise<unknown>; timer: ReturnType<typeof setTimeout> }>();

/**
 * Tells the person of a contact's call that rings with no tab open (`EngineServer.unheardCall`), as a tab out of sight
 * does (useIncomingCallNotice): "Incoming call", private, when Settings → Notifications shows them, in a chat whose calls
 * ring (`callRings`: a muted chat's still do). A click opens the chat, which rings while the offer is fresh. `signal`
 * null: the ring is over (hung up, or answered or declined in a tab opened since), and its notification goes, as it does
 * once the call rang its whole minute. A newer offer of the same call takes the place of the one before.
 */
export function noticeUnheardCall(linkId: string, signal: string | null, chatView: (linkId: string) => { id: string; peerPubKeyZ32: string } | undefined): void {
  const ring = rings.get(linkId);
  if (ring) clearTimeout(ring.timer);
  const view = signal !== null && !linkId.startsWith("group:") ? chatView(linkId) : undefined;
  const chat = view ? chatOfLink(linkId, [view]) : undefined;
  if (!chat || !notificationSettings().systemEnabled || !callRings(chat)) {
    if (!ring) return;
    rings.delete(linkId);
    // Once it is shown: a ring that ended at once would otherwise leave the notification it was about to show.
    void ring.shown.then(() => chrome.runtime.sendMessage({ target: "background", type: "unnotify", id: ring.id } satisfies RuntimeMessage)).catch(() => {});
    return;
  }
  const id = ring?.id ?? crypto.randomUUID();
  const shown = (ring?.shown ?? Promise.resolve())
    .then(() => profileWords())
    .then(({ t }) => chrome.runtime.sendMessage({ target: "background", type: "notify", body: t("pwa.wakeCall"), chat, id } satisfies RuntimeMessage))
    .catch(() => {});
  rings.set(linkId, { id, shown, timer: setTimeout(() => noticeUnheardCall(linkId, null, chatView), CALL_RING_MS) });
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
