import { useMemo, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { CardIndexRow, EngineState, GroupMemberView, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import type { RoutineCard, TaskCard } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { faceCandidates, faceChoice, shownContactName, useFaceChoices, type ContactFace } from "../components/identities/contactFace";
import type { MemberFaceOf } from "../components/chat/SenderAvatar";
import { authorName, groupPath, memberPhoto } from "../lib/groups";
import { contactTag } from "../lib/publicKeyLabel";
import { sameValue } from "../lib/sameValue";
import { listShownSessions } from "../lib/storage";
import { boardEntries, cardSenders, isActiveTask, mergeCopies, type BoardCopy, type BoardEntry, type BoardRoutine, type BoardTask, type CardSender } from "../lib/taskBoard";
import type { ChatSession } from "../lib/types";
import { chatPath } from "../lib/url";
import { useStoredSessions } from "./useStoredSessions";

/*
 * The profile's cards across every chat and group, kept current for the Tasks board and its entry in the chat list.
 * The engine reads them from its card index (`statusCardIndex`): no chat's history is loaded for it. One store for the
 * app: it asks once when something first shows it, and again (at most every `SETTLE_MS`) when a chat's messages change
 * in a way that can touch a card, or a chat or group comes or goes.
 */

const SETTLE_MS = 120;
const NONE: readonly CardIndexRow[] = [];

let rows: readonly CardIndexRow[] = NONE;
/** Per chat, its cards as the index has them (`cardsOf`). */
let indexed = new Map<string, string>();
let loaded = false;
let asked = 0;
/** The latest question is not answered yet. */
let reading = false;
/** Something changed while a question was on its way: asked once more when it answers, not once per change. */
let wanted = false;
/** A chat or group came or went before the first answer: that answer has it, but an error in its place does not. */
let startChanged = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
/** Per chat, its cards as its messages last had them (`cardsOf`). */
const seen = new Map<string, string>();
/** The chats first heard while the first answer was on its way: held against it once it comes. */
const unsure = new Set<string>();

/** A card's message and its last edit: an edit, a new card or a deleted one changes it, a text in the chat does not. */
const cardKey = (id: string, editedAt: number | undefined) => `${id}:${editedAt ?? ""}`;
const cardsOf = (keys: string[]) => keys.sort().join(",");
const boardCard = (m: StoredMessage) => m.card?.kind === "task" || m.card?.kind === "routine" || m.card?.kind === "usage";

function indexOf(next: readonly CardIndexRow[]): Map<string, string> {
  const keys = new Map<string, string[]>();
  for (const row of next) {
    const chat = keys.get(row.linkId);
    if (chat) chat.push(cardKey(row.id, row.editedAt)); else keys.set(row.linkId, [cardKey(row.id, row.editedAt)]);
  }
  return new Map([...keys].map(([linkId, chat]) => [linkId, cardsOf(chat)]));
}

const same = (a: readonly CardIndexRow[], b: readonly CardIndexRow[]) => a.length === b.length &&
  a.every((row, i) => row.linkId === b[i].linkId && row.id === b[i].id && row.editedAt === b[i].editedAt && row.timestamp === b[i].timestamp);

/** Asks again (soon) when a chat first heard before the first answer has other cards than the index. */
function checkUnsure(): void {
  for (const linkId of unsure) if (seen.get(linkId) !== (indexed.get(linkId) ?? "")) soon();
  unsure.clear();
}

function read(): void {
  const mine = ++asked;
  reading = true;
  void engine.call("statusCardIndex").then((next) => {
    // An older answer after a newer question says nothing; a store nobody shows any more keeps nothing.
    if (mine !== asked || !stop) return;
    reading = false;
    startChanged = false;
    if (wanted) { wanted = false; soon(); }
    const first = !loaded;
    loaded = true;
    if (first || !same(rows, next)) {
      rows = next;
      indexed = indexOf(next);
      for (const listener of listeners) listener();
    }
    checkUnsure();
  }, () => {
    if (mine !== asked || !stop) return;
    reading = false;
    if (wanted || (!loaded && startChanged)) { wanted = false; soon(); }
    startChanged = false;
    checkUnsure();
  });
}

function soon(): void {
  if (reading) { wanted = true; return; }
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (!stop) return; if (reading) wanted = true; else read(); }, SETTLE_MS);
}

/** The chats and groups there are: one coming or going changes whose cards the board has. */
const chatIds = (state: EngineState | null) => `${state?.links.map((l) => l.id).join(",") ?? ""}|${state?.groups.map((g) => g.id).join(",") ?? ""}`;

function start(): () => void {
  let ids = chatIds(engine.state);
  const offMessages = engine.onMessages((linkId: string, messages: StoredMessage[]) => {
    // Only a change of the chat's cards changes the board: most messages are not cards, and the whole history the
    // engine posts at start holds the cards the index has. A chat first heard is held against the index instead.
    const cards = cardsOf(messages.filter(boardCard).map((m) => cardKey(m.id, m.edit?.at)));
    const before = seen.get(linkId);
    seen.set(linkId, cards);
    if (before !== undefined) { if (cards !== before) soon(); return; }
    if (reading && !loaded) unsure.add(linkId);
    else if (cards !== (indexed.get(linkId) ?? "")) soon();
  });
  const offState = engine.subscribe(() => {
    const next = chatIds(engine.state);
    if (next === ids) return;
    ids = next;
    // The chats and groups the engine loads as it starts (its links, then its groups) are in its first answer: that
    // question waits for the engine to be ready. Each of them asked again, three reads of the whole index at once.
    if (loaded || !reading) soon(); else startChanged = true;
  });
  read();
  return () => {
    offMessages(); offState();
    if (timer) { clearTimeout(timer); timer = null; }
    rows = NONE; indexed = new Map(); loaded = false; reading = false; wanted = false; startChanged = false;
    seen.clear(); unsure.clear();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stop) { const end = stop; stop = null; end(); }
  };
}

/** Every card message of the profile, oldest first, as the engine's index has them; empty until it answered. */
export function useCardIndex(): readonly CardIndexRow[] {
  return useSyncExternalStore(subscribe, () => rows);
}

/** Whether the engine's index answered yet: until then `useCardIndex` is empty because nothing is known. */
export function useCardIndexRead(): boolean {
  return useSyncExternalStore(subscribe, () => loaded);
}

/*
 * What the board shows of a chat or a group: its name, its members' names, a contact's picture and the identities they
 * can be shown as right now (a proof that expires leaves at the engine's next state). The engine sends a new state a
 * few times a second while its links poll with nothing new, and the page reads the chats again at every message: each
 * a new copy with the same content. So these are kept while their content is the same (`sameValue`, as a chat list's
 * row), and the board is built again only when a name or a picture on it changes.
 */

type BoardLink = Pick<LinkView, "id" | "peerPubKeyZ32" | "peerNick" | "peerAvatar"> & { faces: ContactFace[] };
type BoardChat = Pick<GroupView, "id" | "name" | "formerNames" | "memberLinks"> & { members: Pick<GroupMemberView, "key" | "me" | "nick">[] };
interface BoardChats { links: BoardLink[]; groups: BoardChat[] }
type BoardSession = Pick<ChatSession, "id" | "peerPubKeyB64" | "label" | "nick">;

const chatsOf = (state: EngineState | null): BoardChats => ({
  links: (state?.links ?? []).map((l) => ({ id: l.id, peerPubKeyZ32: l.peerPubKeyZ32, peerNick: l.peerNick, peerAvatar: l.peerAvatar, faces: faceCandidates(l.identities?.received) })),
  groups: (state?.groups ?? []).map((g) => ({
    id: g.id, name: g.name, formerNames: g.formerNames, memberLinks: g.memberLinks,
    members: g.members.map((m) => ({ key: m.key, me: m.me, nick: m.nick })),
  })),
});

let chatsFrom: EngineState | null | undefined;
let chats: BoardChats = chatsOf(null);
const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
/** The chats and groups as the board shows them: the same object until something it shows changes. */
function boardChats(): BoardChats {
  if (engine.state === chatsFrom) return chats;
  chatsFrom = engine.state;
  const next = chatsOf(engine.state);
  if (!sameValue(next, chats)) chats = next;
  return chats;
}

/** Who sent a card, across the profile's chats and groups (`cardSenders`): the same function until a chat or a name changes. */
export function useCardSenders(): (entry: Pick<BoardEntry, "linkId" | "author">) => CardSender {
  const { links, groups } = useSyncExternalStore(subscribeEngine, boardChats);
  return useMemo(() => cardSenders(links, groups), [links, groups]);
}

/** The app's sessions (1:1 chats, kept by the page) as the board shows them, through the page's one cache (`useStoredSessions`). */
const readSessions = (): BoardSession[] => listShownSessions().map((s) => ({ id: s.id, peerPubKeyB64: s.peerPubKeyB64, label: s.label, nick: s.nick }));

export interface TaskBoardData {
  tasks: BoardTask[];
  routines: BoardRoutine[];
  /** Tasks still going. */
  active: number;
  /** The address of a card's chat or group, to open it. */
  pathOf(linkId: string): string | undefined;
  /** A sender's face (a contact's or a member's picture, else their initial); none for my own cards. */
  faceOf(entry: Pick<BoardEntry, "linkId" | "author">): MemberFaceOf | undefined;
}

/**
 * The board's cards with names: each card's chat as the chat list names it, and its sender as that chat does (the
 * contact in a 1:1 chat, the member in a group; a member who is a contact of mine as their own chat names them). A
 * card sent to several chats is one entry (`mergeCopies`). A card whose chat or group is gone from this profile is
 * left out.
 */
export function useTaskBoard(): TaskBoardData {
  const { t } = useI18n();
  const index = useCardIndex();
  const { links, groups } = useSyncExternalStore(subscribeEngine, boardChats);
  const sessions = useStoredSessions(readSessions, sameValue);
  const choices = useFaceChoices();
  return useMemo(() => {
    const groupOf = new Map(groups.map((g) => [`group:${g.id}`, g]));
    /** A 1:1 chat's contact as its chat names and shows them, per chat. */
    const peerOf = new Map<string, { session: BoardSession; key: string; name: string; picture?: string }>();
    const face = (link: BoardLink) => {
      const choice = faceChoice(link.peerPubKeyZ32);
      return choice && choice !== "none" ? link.faces.find((f) => f.provider === choice.provider && f.subject === choice.subject) : undefined;
    };
    for (const link of links) {
      const session = sessions.find((s) => s.peerPubKeyB64 === link.peerPubKeyZ32);
      if (!session) continue;
      const shown = face(link);
      const name = shownContactName({ nickname: session.label, face: shown, nick: session.nick ?? link.peerNick, fallback: t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) }) }).name;
      peerOf.set(link.id, { session, key: session.peerPubKeyB64, name, picture: shown?.photo ?? link.peerAvatar });
    }
    const known = new Set([...peerOf.keys(), ...groupOf.keys()]);
    const senderOf = cardSenders(links, groups);
    const peerOfKey = new Map([...peerOf.values()].map((peer) => [peer.key, peer]));
    const faceOfKey = (peerKey: string | undefined) => { const link = peerKey ? links.find((l) => l.peerPubKeyZ32 === peerKey) : undefined; return link && face(link); };
    const who = (entry: BoardCopy): { botKey: string; bot: string; chat: string } => {
      const group = groupOf.get(entry.linkId);
      if (group) {
        const chat = group.name || t("group.chat.unnamed");
        if (entry.author === "me") return { botKey: "me", bot: t("cards.board.me"), chat };
        // A member who is a contact of mine is that contact, here and in their own chat: one bot, under one name.
        const sender = senderOf(entry);
        return { botKey: sender.key, bot: peerOfKey.get(sender.key)?.name ?? authorName(group, entry.author, t), chat };
      }
      const peer = peerOf.get(entry.linkId)!;
      return entry.author === "me" ? { botKey: "me", bot: t("cards.board.me"), chat: peer.name } : { botKey: peer.key, bot: peer.name, chat: peer.name };
    };
    const entries = mergeCopies(boardEntries(index, known), senderOf);
    const tasks: BoardTask[] = [], routines: BoardRoutine[] = [];
    for (const { copies, ...entry } of entries) {
      const named = { ...who(entry), ...(copies && { copies: copies.map((copy) => ({ ...copy, chat: who(copy).chat })) }) };
      if (entry.card.kind === "task") tasks.push({ ...(entry as Omit<BoardEntry<TaskCard>, "copies">), ...named });
      else routines.push({ ...(entry as Omit<BoardEntry<RoutineCard>, "copies">), ...named });
    }
    return {
      tasks, routines,
      active: tasks.filter((task) => isActiveTask(task.card)).length,
      pathOf: (linkId) => {
        const group = groupOf.get(linkId), peer = peerOf.get(linkId);
        return group ? groupPath(group.id) : peer ? chatPath(peer.session.id) : undefined;
      },
      faceOf: (entry) => {
        if (entry.author === "me") return undefined;
        const group = groupOf.get(entry.linkId);
        if (group) {
          const member = group.members.find((m) => m.key === entry.author);
          const picture = memberPhoto(group, { key: entry.author, me: false }, links, faceOfKey);
          return { key: entry.author, name: member?.nick || group.formerNames?.[entry.author] || "", ...(picture && { picture }) };
        }
        const peer = peerOf.get(entry.linkId);
        return peer && { key: peer.key, name: peer.name, ...(peer.picture && { picture: peer.picture }) };
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `choices` counts the changes of how a contact is shown
  }, [index, links, groups, sessions, choices, t]);
}
