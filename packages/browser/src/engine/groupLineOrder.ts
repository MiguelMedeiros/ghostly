import type { GroupsHost } from "./groups";
import { AUTHOR_ORDER_ROWS, AUTHOR_ORDER_SETTLE_MS, AUTHOR_ORDER_WAIT_MAX_MS, AUTHOR_ORDER_WINDOW_MS } from "./groupAuthorOrder";

/**
 * How long a history's lines wait for the next older message before they are placed again: about the gap between the
 * frames of one catch-up page. Placed at each message, a page of 240 moved the lines 216 times, and every row after them.
 */
export const LINE_ORDER_SETTLE_MS = 3_000;
/** How long the lines wait at most while older messages keep coming: one move every so often in a long catch-up. */
export const LINE_ORDER_WAIT_MAX_MS = AUTHOR_ORDER_SETTLE_MS;

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
 * conversation read long ago never moves. The lines wait for the rest of the older messages (`tick`), and while
 * messages of an epoch before are still on their way (`onTheirWay`) the rows wait for them, as `GroupAuthorOrder`'s do:
 * a row moves about once a catch-up.
 */
export class GroupLineOrder {
  /** Per history: the rows followed, in the order they are placed in it. */
  private readonly rows = new Map<string, Followed[]>();
  /** Per history with rows out of order: since when, and when the last one came. */
  private readonly waiting = new Map<string, { since: number; last: number }>();
  private readonly due = new Set<string>();
  private readonly running = new Set<string>();

  constructor(private readonly host: Pick<GroupsHost, "placeAgain">, private readonly onTheirWay: (linkId: string) => boolean = () => false) {}

  /**
   * A row is being stored, a line of the history or a message sealed under this epoch, and takes its place now: `at` is
   * when, on the engine's clock. Call what this returns with whether it was new: a message below a line of a later
   * epoch takes the line (and the rows after it written knowing it) below it. `above`: the row it is stored just above
   * (`GroupAuthorOrder.above`); else it goes to the end.
   */
  placing(linkId: string, row: { id: string; epoch: number; line: boolean }, at: number, above?: string): (stored: boolean) => void {
    if (!this.host.placeAgain) return () => {};
    const followed: Followed = { ...row, at };
    const rows = (this.rows.get(linkId) ?? []).filter(r => r.at > at - AUTHOR_ORDER_WINDOW_MS).slice(-(AUTHOR_ORDER_ROWS - 1));
    const index = above === undefined ? -1 : rows.findIndex(r => r.id === above);
    if (index >= 0) rows.splice(index, 0, followed);
    else rows.push(followed);
    this.rows.set(linkId, rows);
    return stored => {
      const now = this.rows.get(linkId);
      if (!stored) { if (now) this.rows.set(linkId, now.filter(r => r !== followed)); return; }
      if (followed.line || !now) return;
      const line = now.findIndex(r => r.line && r.epoch > followed.epoch);
      if (line < 0 || line > now.indexOf(followed)) return;
      // The line and the rows after it: followed as if they came now, while they wait for the rest.
      for (const r of now.slice(line)) r.at = Math.max(r.at, at);
      this.wait(linkId, at);
    };
  }

  /** These rows were placed again below everything (`GroupAuthorOrder`), in this order, at `at` on the engine's clock. */
  moved(linkId: string, ids: readonly string[], at: number): void {
    const rows = this.rows.get(linkId);
    if (!rows) return;
    const moved = ids.map(id => rows.find(r => r.id === id)).filter((r): r is Followed => !!r);
    if (!moved.length) return;
    this.rows.set(linkId, [...rows.filter(r => !moved.includes(r)), ...moved]);
    if (moved.some(r => !r.line)) this.wait(linkId, at);
  }

  /**
   * Time passed: histories no older message came to for a moment, and nothing more is on its way for, or that waited
   * long enough, are put in order.
   */
  tick(now: number): void {
    for (const [linkId, { since, last }] of this.waiting) {
      if (now - last < LINE_ORDER_SETTLE_MS && now - since < LINE_ORDER_WAIT_MAX_MS) continue;
      if (now - last < AUTHOR_ORDER_SETTLE_MS && now - since < AUTHOR_ORDER_WAIT_MAX_MS && this.onTheirWay(linkId)) continue;
      this.waiting.delete(linkId);
      this.run(linkId);
    }
  }

  /** The group's history is gone (left or forgotten). */
  forget(linkId: string): void { this.rows.delete(linkId); this.waiting.delete(linkId); this.due.delete(linkId); }

  private wait(linkId: string, at: number): void {
    this.waiting.set(linkId, { since: this.waiting.get(linkId)?.since ?? at, last: at });
  }

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
          // The rows that stay are those at the top of the order already in it among the rows: the older messages that
          // came below the lines stay where they came, and the lines go below them.
          const place = new Map(rows.map((r, i) => [r, i]));
          let from = 0;
          while (from < order.length && (from === 0 || place.get(order[from]!)! > place.get(order[from - 1]!)!)) from++;
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
