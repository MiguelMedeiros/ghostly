import { useSyncExternalStore, type ReactNode } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { PeerAvatar } from "../components/Avatar";
import { GroupAvatar } from "../components/GroupAvatar";
import { shownContactName, useContactFaces } from "../components/identities/contactFace";
import { useI18n } from "../contexts/I18nContext";
import { groupChat } from "../lib/chatMute";
import { groupPath } from "../lib/groups";
import { contactTag } from "../lib/publicKeyLabel";
import { listSessions } from "../lib/storage";
import { chatPath } from "../lib/url";

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

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
}

/**
 * The chats and groups to pick from, most recent first. Groups take text only (files are not part of groups yet): with
 * `files`, they are left out. A group still an invitation, or one this device cannot write in, is never offered.
 */
export function useChatTargets({ files }: { files: boolean }): ChatTarget[] {
  const { t } = useI18n();
  const faceOf = useContactFaces();
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const chats = listSessions().map((session): ChatTarget => {
    const face = faceOf(session.peerPubKeyB64);
    const shown = shownContactName({ nickname: session.label, face, nick: session.nick, fallback: t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) }) });
    const last = session.messages[session.messages.length - 1]?.timestamp;
    return {
      kind: "chat", chat: session.id, target: state?.links.find(link => link.peerPubKeyZ32 === session.peerPubKeyB64)?.id, path: chatPath(session.id),
      name: shown.name, at: last ?? session.lastSyncAt ?? session.createdAt,
      avatar: <PeerAvatar peerPubKey={session.peerPubKeyB64} label={shown.name} named={shown.from !== "key"} photo={face?.photo} />,
    };
  });
  const groups = files ? [] : (state?.groups ?? []).filter(group => !group.invitation && group.canSend).map((group): ChatTarget => ({
    kind: "group", chat: groupChat(group.id), target: `group:${group.id}`, path: groupPath(group.id), name: group.name, at: group.lastMessageAt,
    avatar: <GroupAvatar picture={group.picture} size={36} />,
  }));
  return [...chats, ...groups].sort((a, b) => b.at - a.at);
}
