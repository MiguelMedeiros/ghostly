import type { GroupsHost } from "./groups";
import { AUTHOR_ORDER_ROWS, AUTHOR_ORDER_WINDOW_MS } from "./groupAuthorOrder";

/** A row of a group's history followed: a line of its history (a membership change) or a message, and its epoch. */
interface Followed { id: string; epoch: number; line: boolean; at: number }

/**
 * The lines of a group's history ("… joined", "… is no longer a member") among the messages of their moment, for a
 * member back from away (WISP 902 § Catch-up). A message sealed under an epoch was written before its author knew of
 * the next commit, so the line of that commit goes below it; a message under the commit's epoch or a later one was
 * written knowing it, and stays below the line. A catch-up brings the commits first (a commit opens the messages of
 * its epoch) and, in a private group, the answers of several members race, so the messages of the epoch before can come
 * after the line. Then the line, and the rows after it written knowing it, are placed again below them, in their order;
 * no clock is read. A row only ever moves down, and only rows placed here in the last few minutes, so a live
 * conversation read long ago never moves. Moves made meanwhile go in one turn: a row moves about once a catch-up page.
 */
export class GroupLineOrder {
  /** Per history: the rows followed, in the order they are placed in it. */
  private readonly rows = new Map<string, Followed[]>();
  private readonly due = new Set<string>();
  private readonly running = new Set<string>();

  constructor(private readonly host: Pick<GroupsHost, "placeAgain">) {}

  /**
   * A row is being stored, a line of the history or a message sealed under this epoch, and takes its place now: `at` is
   * when, on the engine's clock. Call what this returns with whether it was new: a message below a line of a later
   * epoch takes the line (and the rows after it written knowing it) below it.
   */
  placing(linkId: string, row: { id: string; epoch: number; line: boolean }, at: number): (stored: boolean) => void {
    if (!this.host.placeAgain) return () => {};
    const followed: Followed = { ...row, at };
    const rows = (this.rows.get(linkId) ?? []).filter(r => r.at > at - AUTHOR_ORDER_WINDOW_MS).slice(-(AUTHOR_ORDER_ROWS - 1));
    rows.push(followed);
    this.rows.set(linkId, rows);
    return stored => {
      const now = this.rows.get(linkId);
      if (!stored) { if (now) this.rows.set(linkId, now.filter(r => r !== followed)); return; }
      if (!followed.line && now?.some(r => r.line && r.epoch > followed.epoch && now.indexOf(r) < now.indexOf(followed))) this.run(linkId);
    };
  }

  /** These rows were placed again below everything (`GroupAuthorOrder`), in this order. */
  moved(linkId: string, ids: readonly string[]): void {
    const rows = this.rows.get(linkId);
    if (!rows) return;
    const moved = ids.map(id => rows.find(r => r.id === id)).filter((r): r is Followed => !!r);
    if (!moved.length) return;
    this.rows.set(linkId, [...rows.filter(r => !moved.includes(r)), ...moved]);
    if (moved.some(r => !r.line)) this.run(linkId);
  }

  /** The group's history is gone (left or forgotten). */
  forget(linkId: string): void { this.rows.delete(linkId); this.due.delete(linkId); }

  /** The history's rows put in order; what comes while a move is written goes in the next turn. */
  private run(linkId: string): void {
    this.due.add(linkId);
    if (this.running.has(linkId)) return;
    this.running.add(linkId);
    void (async () => {
      try {
        while (this.due.delete(linkId)) {
          const rows = this.rows.get(linkId) ?? [];
          // Each message goes above the first line of a later epoch placed before it; the rest keeps its order.
          const order: Followed[] = [];
          for (const row of rows) {
            const above = row.line ? -1 : order.findIndex(r => r.line && r.epoch > row.epoch);
            if (above < 0) order.push(row); else order.splice(above, 0, row);
          }
          let from = 0;
          while (from < rows.length && rows[from] === order[from]) from++;
          if (from === rows.length) continue;
          // Placed as if they came now: followed for as long as one that came now.
          const last = rows[rows.length - 1]!.at;
          for (const r of order.slice(from)) r.at = Math.max(r.at, last);
          this.rows.set(linkId, order);
          await this.host.placeAgain!(linkId, order.slice(from).map(r => r.id)).catch(() => {});
        }
      } finally {
        this.running.delete(linkId);
      }
    })();
  }
}
