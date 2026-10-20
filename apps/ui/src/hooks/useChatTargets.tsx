import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { PeerAvatar } from "../components/Avatar";
import { GroupAvatar } from "../components/GroupAvatar";
import { shownContactName, useContactFaces } from "../components/identities/contactFace";
import { useI18n } from "../contexts/I18nContext";
import { groupChat } from "../lib/chatMute";
import { groupPath } from "../lib/groups";
import { contactTag } from "../lib/publicKeyLabel";
import { listShownSessions } from "../lib/storage";
import type { ChatSession } from "../lib/types";
import { chatPath } from "../lib/url";
import { useStoredSessions } from "./useStoredSessions";

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

/** The same chats, in the same order, through the page's cache: a chat's object changes only when its stored copy did. */
const sameSessions = (next: ChatSession[], before: ChatSession[]) => next.length === before.length && next.every((s, i) => s === before[i]);

/**
 * A chat something can be sent to from outside it: a share from another app (`SharePicker`), or forwarded messages
 * (`ForwardDialog`). `chat` is the chat's key here (what a draft or a mute names), `target` the engine's (a link id,
 * or `group:<id>`), `path` where it opens.
 */
export interface ChatTarget {
  kind: "chat" | "group";
  chat: string;
  target?: string;
  path: string;
  name: string;
  /** When something last happened in it: the list shows the most recent first. */
  at: number;
  avatar: ReactNode;
  /** A paired 1:1 chat (`paired-chat/1`), the kind with a link: where an app's panel is (`AppChatPicker`). */
  paired?: boolean;
}

/**
 * The chats and groups to pick from, most recent first; groups take texts and files alike (WISP 503), private groups
 * and communities. A group still an invitation, or one this device cannot write in, is never offered.
 *
 * The chats come through the page's one cache, read again when one changes (`useStoredSessions`), not at every engine
 * state: with a picker open during a call or a file transfer the engine changes many times a second, and each change
 * used to re-read every chat's stored messages. That reading is the whole saving: the list itself is still made on each
 * engine state (the links, the groups and the faces come with it), and is cheap once the chats are in memory.
 */
export function useChatTargets(): ChatTarget[] {
  const { t } = useI18n();
  const faceOf = useContactFaces();
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const sessions = useStoredSessions(listShownSessions, sameSessions);
  const links = state?.links;
  const groups = state?.groups;
  return useMemo(() => {
    const linkOf = new Map(links?.map(link => [link.peerPubKeyZ32, link.id]));
    const chats = sessions.map((session): ChatTarget => {
      const face = faceOf(session.peerPubKeyB64);
      const shown = shownContactName({ nickname: session.label, face, nick: session.nick, fallback: t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) }) });
      const last = session.messages[session.messages.length - 1]?.timestamp;
      return {
        kind: "chat", chat: session.id, target: linkOf.get(session.peerPubKeyB64), path: chatPath(session.id),
        name: shown.name, at: last ?? session.lastSyncAt ?? session.createdAt, paired: session.profile === "paired-chat/1",
        avatar: <PeerAvatar peerPubKey={session.peerPubKeyB64} label={shown.name} named={shown.from !== "key"} photo={face?.photo} />,
      };
    });
    const groupTargets = (groups ?? []).filter(group => !group.invitation && group.canSend).map((group): ChatTarget => ({
      kind: "group", chat: groupChat(group.id), target: `group:${group.id}`, path: groupPath(group.id), name: group.name, at: group.lastMessageAt,
      avatar: <GroupAvatar picture={group.picture} size={36} />,
    }));
    return [...chats, ...groupTargets].sort((a, b) => b.at - a.at);
  }, [sessions, links, groups, faceOf, t]);
}
