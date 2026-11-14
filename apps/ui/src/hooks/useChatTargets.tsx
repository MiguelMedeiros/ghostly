import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
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

/** What the list is made of from the engine's state: each chat's link by its contact's key, and the groups to send to. */
interface TargetInputs {
  links: readonly (readonly [string, string])[];
  groups: readonly Pick<GroupView, "id" | "name" | "picture" | "lastMessageAt">[];
}
let held: { state: unknown; inputs: TargetInputs } | null = null;
const sameLinks = (a: TargetInputs["links"], b: TargetInputs["links"]) => a.length === b.length && a.every(([key, id], i) => key === b[i]![0] && id === b[i]![1]);
const sameGroups = (a: TargetInputs["groups"], b: TargetInputs["groups"]) => a.length === b.length
  && a.every((g, i) => g.id === b[i]!.id && g.name === b[i]!.name && g.picture === b[i]!.picture && g.lastMessageAt === b[i]!.lastMessageAt);

/**
 * The engine sends its chats and groups anew on every state (up to 20 a second while a file moves): the inputs held stay
 * the same object while what the list shows of them does, so an open picker draws its rows again only when they change.
 */
function targetInputs(): TargetInputs {
  const state = engine.state;
  if (held && held.state === state) return held.inputs;
  const links = (state?.links ?? []).map((link) => [link.peerPubKeyZ32, link.id] as const);
  const groups = (state?.groups ?? []).filter((group) => !group.invitation && group.canSend)
    .map(({ id, name, picture, lastMessageAt }) => ({ id, name, picture, lastMessageAt }));
  const inputs = held && sameLinks(held.inputs.links, links) && sameGroups(held.inputs.groups, groups) ? held.inputs : { links, groups };
  held = { state, inputs };
  return inputs;
}

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
 * used to re-read every chat's stored messages. The list is made again only when what it holds of the state changes
 * (`targetInputs`): a state that moves a file draws no picker's rows again.
 */
export function useChatTargets(): ChatTarget[] {
  const { t } = useI18n();
  const faceOf = useContactFaces();
  const { links, groups } = useSyncExternalStore(subscribeEngine, targetInputs);
  const sessions = useStoredSessions(listShownSessions, sameSessions);
  return useMemo(() => {
    const linkOf = new Map(links);
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
    const groupTargets = groups.map((group): ChatTarget => ({
      kind: "group", chat: groupChat(group.id), target: `group:${group.id}`, path: groupPath(group.id), name: group.name, at: group.lastMessageAt,
      avatar: <GroupAvatar picture={group.picture} size={36} />,
    }));
    return [...chats, ...groupTargets].sort((a, b) => b.at - a.at);
  }, [sessions, links, groups, faceOf, t]);
}
