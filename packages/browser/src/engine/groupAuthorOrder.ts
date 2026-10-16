import type { GroupsHost } from "./groups";

/**
 * How long a member's message may still be placed again below that member's older ones (WISP 400, requirement 10):
 * about a catch-up, whose answers end within the three minutes the app waits for the first.
 */
export const AUTHOR_ORDER_WINDOW_MS = 3 * 60_000;
/** The rows of a group followed at most: those a member keeps for the others and the author's own last 32, twice. */
export const AUTHOR_ORDER_ROWS = 576;
/**
 * While some of a member's messages are still on their way, how long that member's rows wait for the next one before
 * they are placed again anyway: longer than a catch-up takes to ask for its next 32 (`MESH_GAP_AGAIN_MS`, 10 s). Placed
 * at each page, the newest rows moved down again with every older page, up to 84 writes a row for 200 caught up.
 */
export const AUTHOR_ORDER_SETTLE_MS = 15_000;
/** How long a member's rows wait at most, however their catch-up goes on: well within the rows followed. */
export const AUTHOR_ORDER_WAIT_MAX_MS = AUTHOR_ORDER_WINDOW_MS / 2;
/**
 * How far at most, in places of the history (milliseconds), below a member's later row an older one of theirs is
 * stored (`GroupsHost.placeAbove`): twice the page a catch-up asks for (`GROUP_LIMITS.miss`), so a page's rows follow
 * one another below the row and the next page still finds room above them.
 */
export const AUTHOR_ORDER_ROOM = 64;

interface Placed { sender: string; epoch: number; seq: number; id: string; at: number }
/** A row followed, and `n`: when it came, among the rows of its group (one stored `above` came after those below it). */
type Followed = Placed & { n: number };

/** Whether `a` was written after `b` by the same member: a later epoch, or a higher number in the same one. */
function after(a: Pick<Placed, "epoch" | "seq">, b: Pick<Placed, "epoch" | "seq">): boolean {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.seq > b.seq);
}

/**
 * A member's messages in a private group in the order that member wrote them (WISP 400, requirement 10, and WISP 902
 * § Catch-up). A message is placed where it arrives. When one comes of a member whose later messages were placed here
 * moments ago (two catch-up answers raced: the author's own newest 32 and another member's hand-on of the older ones),
 * it is stored just above the first of them where the history has room there (`above`): the author's newest stays
 * the last while the older pages come. Where it has none, those later ones are placed again below it, in the order
 * they were written, and the lines that came after them before the older one (another member's, mine) go along below
 * them, in their order: a reply to the newest stays below it. A row only ever moves down, so nobody else's lines change
 * order. While messages of that member are still missing (`missing`), the rows wait for them, so each row moves about
 * once in a whole catch-up.
 */
export class GroupAuthorOrder {
  /** Per group: the members' rows followed, in the order they are placed in the history. */
  private readonly rows = new Map<string, Followed[]>();
  private came = 0;
  /** Per group: the members with a row placed above an older one of theirs, since when, and when their last row came. */
  private readonly due = new Map<string, Map<string, { since: number; last: number }>>();
  private readonly running = new Set<string>();

  constructor(private readonly host: Pick<GroupsHost, "placeAgain">, private readonly linkOf: (groupId: string) => string,
    private readonly missing: (groupId: string, sender: string) => boolean = () => false) {}

  /**
   * The row a member's message about to be stored goes just above: the first placed of those that member wrote after
   * it, when nobody else's came after that one (a hand-on of everyone's older messages brings them in the order they
   * were written: the message goes after those). None when nothing they wrote later was placed here, or another's
   * came since: it goes where it comes.
   */
  above(groupId: string, row: Omit<Placed, "at">): string | undefined {
    const rows = this.rows.get(groupId) ?? [];
    if (rows.some(r => r.id === row.id)) return undefined;
    const at = rows.findIndex(r => r.sender === row.sender && after(r, row));
    return at >= 0 && rows.slice(at).every(r => r.sender === row.sender) ? rows[at].id : undefined;
  }

  /**
   * A member's message was stored in the group's history, new: `at` is when, on the engine's clock. `above`: the row
   * it was stored just above, as `above` named it; else it went to the end.
   */
  placed(groupId: string, row: Placed, above?: string): void {
    if (!this.host.placeAgain) return;
    const rows = (this.rows.get(groupId) ?? []).filter(r => r.at > row.at - AUTHOR_ORDER_WINDOW_MS).slice(-(AUTHOR_ORDER_ROWS - 1));
    const at = above === undefined ? -1 : rows.findIndex(r => r.id === above);
    const followed = { ...row, n: ++this.came };
    if (at >= 0) rows.splice(at, 0, followed);
    else rows.push(followed);
    this.rows.set(groupId, rows);
    let due = this.due.get(groupId);
    const first = rows.slice(0, at >= 0 ? at : -1).findIndex(r => r.sender === row.sender && after(r, row));
    if (!due?.has(row.sender) && first < 0) return;
    // The rows to place again, and those that go along: followed as if they came now, while they wait for the rest.
    if (first >= 0) for (const r of rows.slice(first)) r.at = Math.max(r.at, row.at);
    if (!due) this.due.set(groupId, (due = new Map()));
    due.set(row.sender, { since: due.get(row.sender)?.since ?? row.at, last: row.at });
    if (!this.missing(groupId, row.sender)) void this.run(groupId, row.at);
  }

  /** Time passed: rows nothing more is on its way for, or that waited long enough, are placed again. */
  tick(now: number): void {
    for (const groupId of this.due.keys()) void this.run(groupId, now);
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
  private async run(groupId: string, now: number): Promise<void> {
    if (this.running.has(groupId)) return;
    this.running.add(groupId);
    try {
      for (;;) {
        const due = this.due.get(groupId);
        const ready = [...(due ?? [])].filter(([sender, { since, last }]) =>
          now - last >= AUTHOR_ORDER_SETTLE_MS || now - since >= AUTHOR_ORDER_WAIT_MAX_MS || !this.missing(groupId, sender)).map(([sender]) => sender);
        if (!ready.length) break;
        for (const sender of ready) due!.delete(sender);
        if (!due!.size) this.due.delete(groupId);
        for (const sender of ready) {
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
          const newer = mine.filter(r => !after(from!, r)).sort((a, b) => (after(a, b) ? 1 : after(b, a) ? -1 : 0));
          const ids = new Set(newer.map(r => r.id));
          // The others' rows (mine too) that came after the first of them, before any older one of the member's,
          // follow them in their order: written below those rows (a reply to the newest), they stay below them. Those
          // that came with the older ones were written among them, and stay. Read in the order they came: an older one
          // stored just above came after the rows below it.
          const first = rows.findIndex(r => ids.has(r.id));
          let end = Infinity, top = rows[first]!;
          for (const r of rows.filter(r => r.n > rows[first]!.n).sort((a, b) => a.n - b.n)) {
            if (r.sender !== sender) continue;
            if (after(top, r)) { end = r.n; break; }
            top = r;
          }
          const followers = rows.slice(first).filter(r => r.sender !== sender && r.n < end);
          for (const r of followers) ids.add(r.id);
          const moved = [...newer, ...followers];
          // Placed as if they came now: followed for as long as one that came now, through a long catch-up.
          this.rows.set(groupId, [...rows.filter(r => !ids.has(r.id)), ...moved.map(r => ({ ...r, at: Math.max(r.at, now), n: ++this.came }))]);
          await this.host.placeAgain!(this.linkOf(groupId), moved.map(r => r.id)).catch(() => {});
        }
      }
    } finally {
      this.running.delete(groupId);
    }
  }
}
