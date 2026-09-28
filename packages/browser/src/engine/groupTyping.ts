import {
  GroupTypingBoard, TypingSender, groupTypingEpoch, openGroupTyping, rosterHas, sealGroupTyping,
  type GroupSession, type GroupTypingFrame, type TypingActivity,
} from "@ghostly/core";
import type { GroupTypingView } from "../shared/types";
import type { GroupsHost } from "./groups";

/**
 * Typing in private groups (WISP 9xx · Group Mesh § Typing): this side's word goes sealed on every open edge to a
 * member, and each member's word is shown until its `stop`, its message, or 6 s without a new `start`. Never stored.
 * Community groups do not carry it yet (their frames are all stored messages).
 */
export class GroupTypings {
  private readonly boards = new Map<string, GroupTypingBoard>();
  private readonly senders = new Map<string, TypingSender>();

  constructor(private readonly host: Pick<GroupsHost, "edges" | "linkReady" | "sendOnLink" | "emit">, private readonly now: () => number = Date.now) {}

  /** This side is typing in the group (with what it is doing), or stopped. A `stop` goes only when a `start` stands. */
  say(session: GroupSession, typing: boolean, activity?: TypingActivity): void {
    const groupId = session.id;
    let sender = this.senders.get(groupId);
    if (!sender) this.senders.set(groupId, (sender = new TypingSender(this.now)));
    if (typing && session.status !== "active") return;
    const word = typing ? sender.typing(activity) : sender.stopped();
    const secret = session.state.secrets[session.epoch];
    if (!word || !secret) return;
    const frame = sealGroupTyping(groupId, session.epoch, secret, session.myKey, word);
    for (const [key, linkId] of this.host.edges(groupId)) {
      if (key === session.myKey || !rosterHas(session.roster, key) || !this.host.linkReady(linkId)) continue;
      try { this.host.sendOnLink(linkId, frame); } catch { /* down: typing is not caught up */ }
    }
  }

  /** A `group-typing` frame on the edge pinned to `from`: shown only from a member, and only when it opens. */
  heard(session: GroupSession, from: string, raw: unknown): void {
    const epoch = groupTypingEpoch(raw, session.id);
    if (epoch === null || session.status !== "active" || from === session.myKey || !rosterHas(session.roster, from)) return;
    const secret = session.state.secrets[epoch];
    const word = secret ? openGroupTyping(raw as GroupTypingFrame, secret, from) : null;
    if (word) this.board(session.id).receive(from, word);
  }

  /** A message from `member` arrived: it is not typing any more. */
  messageFrom(groupId: string, member: string): void { this.boards.get(groupId)?.clear(member); }

  /** Who is typing in the group now, for its view; undefined for nobody. */
  view(session: GroupSession): GroupTypingView[] | undefined {
    if (session.status !== "active") return undefined;
    const typing = this.boards.get(session.id)?.typing(session.others) ?? [];
    return typing.length ? typing.map(({ member, activity }) => ({ key: member, ...(activity.kind !== "typing" ? { kind: activity.kind } : {}), ...(activity.status ? { status: activity.status } : {}) })) : undefined;
  }

  /** The group is gone from this device: nothing stands. */
  forget(groupId: string): void {
    this.boards.get(groupId)?.clearAll();
    this.boards.delete(groupId);
    this.senders.delete(groupId);
  }

  private board(groupId: string): GroupTypingBoard {
    let board = this.boards.get(groupId);
    if (!board) this.boards.set(groupId, (board = new GroupTypingBoard(() => this.host.emit(), this.now)));
    return board;
  }
}
