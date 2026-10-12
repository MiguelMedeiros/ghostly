import type { GroupsHost } from "./groups";

/**
 * How long a member's message may still be placed again below that member's older ones (WISP 400, requirement 10):
 * about a catch-up, whose answers end within the three minutes the app waits for the first.
 */
export const AUTHOR_ORDER_WINDOW_MS = 3 * 60_000;
/** The rows of a group followed at most: those a member keeps for the others and the author's own last 32, twice. */
export const AUTHOR_ORDER_ROWS = 576;

interface Placed { sender: string; epoch: number; seq: number; id: string; at: number }

/** Whether `a` was written after `b` by the same member: a later epoch, or a higher number in the same one. */
function after(a: Placed, b: Placed): boolean {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.seq > b.seq);
}

/**
 * A member's messages in a private group in the order that member wrote them (WISP 400, requirement 10, and WISP 902
 * § Catch-up). A message is placed where it arrives. When one comes of a member whose later messages were placed here
 * moments ago (two catch-up answers raced: the author's own newest 32 and another member's hand-on of the older ones),
 * those later ones are placed again below it, in the order they were written. A row only ever moves down, past what
 * came after it, so nobody else's lines change order and the author's newest is the last.
 */
export class GroupAuthorOrder {
  /** Per group: the members' rows followed, in the order they are placed in the history. */
  private readonly rows = new Map<string, Placed[]>();
  /** Per group: the members with a row placed above an older one of theirs. */
  private readonly due = new Map<string, Set<string>>();
  private readonly running = new Set<string>();

  constructor(private readonly host: Pick<GroupsHost, "placeAgain">, private readonly linkOf: (groupId: string) => string) {}

  /** A member's message was stored in the group's history, new: `at` is when, on the engine's clock. */
  placed(groupId: string, row: Placed): void {
    if (!this.host.placeAgain) return;
    const rows = (this.rows.get(groupId) ?? []).filter(r => r.at > row.at - AUTHOR_ORDER_WINDOW_MS).slice(-(AUTHOR_ORDER_ROWS - 1));
    rows.push(row);
    this.rows.set(groupId, rows);
    if (!rows.some(r => r.sender === row.sender && after(r, row))) return;
    let due = this.due.get(groupId);
    if (!due) this.due.set(groupId, (due = new Set()));
    due.add(row.sender);
    void this.run(groupId);
  }

  /** The group's history is gone (left or forgotten). */
  forget(groupId: string): void {
    this.rows.delete(groupId);
    this.due.delete(groupId);
  }

  /**
   * One group's rows put in order, a member at a time; what comes meanwhile is put in order by the next turn, so a
   * catch-up's frames that come together move each row once, not once per frame.
   */
  private async run(groupId: string): Promise<void> {
    if (this.running.has(groupId)) return;
    this.running.add(groupId);
    try {
      for (let due = this.due.get(groupId); due?.size; due = this.due.get(groupId)) {
        this.due.delete(groupId);
        for (const sender of due) {
          const rows = this.rows.get(groupId) ?? [];
          const mine = rows.filter(r => r.sender === sender);
          // The oldest row with an older one placed below it: from it on, the member's rows go below everything, in
          // the order written. Those before it were placed in order already, and stay.
          let from: Placed | undefined, below: Placed | undefined;
          for (const r of [...mine].reverse()) {
            if (below && after(r, below) && (!from || after(from, r))) from = r;
            if (!below || after(below, r)) below = r;
          }
          if (!from) continue;
          const moved = mine.filter(r => !after(from!, r)).sort((a, b) => (after(a, b) ? 1 : after(b, a) ? -1 : 0));
          const ids = new Set(moved.map(r => r.id));
          this.rows.set(groupId, [...rows.filter(r => !ids.has(r.id)), ...moved]);
          await this.host.placeAgain!(this.linkOf(groupId), moved.map(r => r.id)).catch(() => {});
        }
      }
    } finally {
      this.running.delete(groupId);
    }
  }
}
