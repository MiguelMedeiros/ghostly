import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { CardIndexRow, EngineState, StoredMessage } from "@ghostly/browser/shared/types";
import type { RoutineCard, TaskCard } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { shownContactName, useContactFaces } from "../components/identities/contactFace";
import type { MemberFaceOf } from "../components/chat/SenderAvatar";
import { authorName, groupPath, memberPhoto } from "../lib/groups";
import { useEngineState } from "../lib/identities";
import { contactTag } from "../lib/publicKeyLabel";
import { listSessions } from "../lib/storage";
import { boardEntries, isActiveTask, type BoardEntry, type BoardRoutine, type BoardTask } from "../lib/taskBoard";
import type { ChatSession } from "../lib/types";
import { chatPath } from "../lib/url";

/*
 * The profile's cards across every chat and group, kept current for the Tasks board and its entry in the chat list.
 * The engine reads them from its card index (`statusCardIndex`): no chat's history is loaded for it. One store for the
 * app: it asks once when something first shows it, and again (at most every `SETTLE_MS`) when a chat's messages change
 * in a way that can touch a card, or a chat or group comes or goes.
 */

const SETTLE_MS = 120;
const NONE: readonly CardIndexRow[] = [];

let rows: readonly CardIndexRow[] = NONE;
let loaded = false;
let asked = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

const same = (a: readonly CardIndexRow[], b: readonly CardIndexRow[]) => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

function read(): void {
  const mine = ++asked;
  void engine.call("statusCardIndex").then((next) => {
    // An older answer after a newer question says nothing; a store nobody shows any more keeps nothing.
    if (mine !== asked || !stop) return;
    const first = !loaded;
    loaded = true;
    if (!first && same(rows, next)) return;
    rows = next;
    for (const listener of listeners) listener();
  }, () => {});
}

function soon(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (stop) read(); }, SETTLE_MS);
}

/** The chats and groups there are: one coming or going changes whose cards the board has. */
const chatIds = (state: EngineState | null) => `${state?.links.map((l) => l.id).join(",") ?? ""}|${state?.groups.map((g) => g.id).join(",") ?? ""}`;

function start(): () => void {
  let ids = chatIds(engine.state);
  const offMessages = engine.onMessages((linkId: string, messages: StoredMessage[]) => {
    // A chat without cards, before and after, changes nothing here: most messages are not cards.
    if (messages.some((m) => m.card) || rows.some((row) => row.linkId === linkId)) soon();
  });
  const offState = engine.subscribe(() => {
    const next = chatIds(engine.state);
    if (next !== ids) { ids = next; soon(); }
  });
  read();
  return () => {
    offMessages(); offState();
    if (timer) { clearTimeout(timer); timer = null; }
    rows = NONE; loaded = false;
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

/** The app's sessions (1:1 chats, kept by the page), read again when one changes. */
function useSessions(): ChatSession[] {
  const [sessions, setSessions] = useState<ChatSession[]>(() => listSessions());
  useEffect(() => {
    const refresh = () => setSessions(listSessions());
    refresh();
    window.addEventListener("session-updated", refresh);
    return () => window.removeEventListener("session-updated", refresh);
  }, []);
  return sessions;
}

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
 * contact in a 1:1 chat, the member in a group). A card whose chat or group is gone from this profile is left out.
 */
export function useTaskBoard(): TaskBoardData {
  const { t } = useI18n();
  const index = useCardIndex();
  const state = useEngineState();
  const sessions = useSessions();
  const contactFace = useContactFaces();
  return useMemo(() => {
    const links = state?.links ?? [], groups = state?.groups ?? [];
    const sessionOf = new Map<string, ChatSession>();
    for (const link of links) {
      const session = sessions.find((s) => s.peerPubKeyB64 === link.peerPubKeyZ32);
      if (session) sessionOf.set(link.id, session);
    }
    const groupOf = new Map(groups.map((g) => [`group:${g.id}`, g]));
    const known = new Set([...sessionOf.keys(), ...groupOf.keys()]);
    const contact = (linkId: string) => {
      const session = sessionOf.get(linkId)!;
      const link = links.find((l) => l.id === linkId);
      const face = contactFace(session.peerPubKeyB64);
      const name = shownContactName({ nickname: session.label, face, nick: session.nick ?? link?.peerNick, fallback: t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) }) }).name;
      return { key: session.peerPubKeyB64, name, picture: face?.photo ?? link?.peerAvatar };
    };
    const who = (entry: Pick<BoardEntry, "linkId" | "author">): { botKey: string; bot: string; chat: string } => {
      const group = groupOf.get(entry.linkId);
      if (group) {
        const chat = group.name || t("group.chat.unnamed");
        if (entry.author === "me") return { botKey: "me", bot: t("cards.board.me"), chat };
        return { botKey: entry.author, bot: authorName(group, entry.author, t), chat };
      }
      const peer = contact(entry.linkId);
      return entry.author === "me" ? { botKey: "me", bot: t("cards.board.me"), chat: peer.name } : { botKey: peer.key, bot: peer.name, chat: peer.name };
    };
    const entries = boardEntries(index, known);
    const tasks: BoardTask[] = [], routines: BoardRoutine[] = [];
    for (const entry of entries) {
      if (entry.card.kind === "task") tasks.push({ ...(entry as BoardEntry<TaskCard>), ...who(entry) });
      else routines.push({ ...(entry as BoardEntry<RoutineCard>), ...who(entry) });
    }
    return {
      tasks, routines,
      active: tasks.filter((task) => isActiveTask(task.card)).length,
      pathOf: (linkId) => {
        const group = groupOf.get(linkId), session = sessionOf.get(linkId);
        return group ? groupPath(group.id) : session ? chatPath(session.id) : undefined;
      },
      faceOf: (entry) => {
        if (entry.author === "me") return undefined;
        const group = groupOf.get(entry.linkId);
        if (group) {
          const member = group.members.find((m) => m.key === entry.author);
          const picture = memberPhoto(group, { key: entry.author, me: false }, links, contactFace);
          return { key: entry.author, name: member?.nick || group.formerNames?.[entry.author] || "", ...(picture && { picture }) };
        }
        if (!sessionOf.has(entry.linkId)) return undefined;
        const peer = contact(entry.linkId);
        return { key: peer.key, name: peer.name, ...(peer.picture && { picture: peer.picture }) };
      },
    };
  }, [index, state, sessions, contactFace, t]);
}
