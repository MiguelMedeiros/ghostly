/**
 * The chats live when this app last ran, back after a restart a few at a time (`RESUMES_AT_ONCE` in node.ts), the most
 * recently live first; the next starts as soon as one is done: live again, its contact found away, or its resume
 * window over (`RESUME_SPENT_MS`). Started all at once, every chat read its contact and offered or answered in the
 * same second, the relays' per-minute budget was spread over all of them, and few got through a whole offer/answer
 * round: a daemon whose 50 contacts were all online had 13 to 30 of them back after 3 to 4.5 min, most chats' resumes
 * spent before they finished. A chat someone wants now (opened, written to) starts at once, ahead of the line. A chat
 * waiting its turn has not started: it reads as offline until then, as a chat does before its link starts.
 */
export class ResumeTurns {
  /** The chats resuming now. */
  private readonly running = new Set<string>();
  /** The chats waiting for a turn, first in line first. */
  private readonly line: string[] = [];

  /** `begin`: starts the chat's link; false when it did not start (gone, started already, offline). */
  constructor(private readonly atOnce: number, private readonly begin: (linkId: string) => boolean) {}

  /** Starts the chat now if a turn is free, or puts it at the end of the line. */
  add(linkId: string): void {
    if (this.running.has(linkId) || this.line.includes(linkId)) return;
    this.line.push(linkId);
    this.next();
  }

  /** The chat is done resuming (live, its contact away, its window over, gone): its turn goes to the next in line. */
  finished(linkId: string): void {
    const at = this.line.indexOf(linkId);
    if (at >= 0) this.line.splice(at, 1);
    if (this.running.delete(linkId)) this.next();
  }

  /** Someone wants the chat now: if it waits in line, it starts at once, past the turns. */
  now(linkId: string): void {
    const at = this.line.indexOf(linkId);
    if (at < 0) return;
    this.line.splice(at, 1);
    this.running.add(linkId);
    if (!this.begin(linkId)) this.running.delete(linkId);
  }

  /** Nothing waits any more (the network went off, the app stops): links started later queue anew. */
  clear(): void {
    this.running.clear();
    this.line.length = 0;
  }

  private next(): void {
    while (this.running.size < this.atOnce && this.line.length) {
      const linkId = this.line.shift()!;
      this.running.add(linkId);
      if (!this.begin(linkId)) this.running.delete(linkId);
    }
  }
}
