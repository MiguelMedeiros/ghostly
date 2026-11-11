import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkView } from "@ghostly/browser/shared/types";
import { node, state, type ApiContext } from "./apiKit";
import { CliError } from "./errors";

/**
 * `chat disconnect --hold <minutes>`: a chat kept off its direct link for a while. It is the chat's own "DHT only"
 * choice (WISP 400: either side choosing it keeps both off the live link, so the contact's app does not redial),
 * taken back when the time is up. Text still goes over the DHT (short texts), files wait. The holds are kept in
 * the profile folder: a daemon that restarts takes back the ones whose time is up, and never a DHT only the chat had
 * chosen before (that one is not a hold).
 */
export const HOLD_MAX_MINUTES = 7 * 24 * 60;

interface Hold { until: number; since: number }
type Holds = Record<string, Hold>;

/** Per chat held: what stops its wait (the timer, or the wait for the chat to open: `expire`). */
const timers = new WeakMap<ApiContext, Map<string, () => void>>();

function holdsFile(ctx: ApiContext): string {
  return join(ctx.runtime.paths.dir, "holds.json");
}

function readHolds(ctx: ApiContext): Holds {
  try { return JSON.parse(readFileSync(holdsFile(ctx), "utf8")) as Holds; } catch { return {}; }
}

function writeHolds(ctx: ApiContext, holds: Holds): void {
  const file = holdsFile(ctx);
  writeFileSync(file + ".tmp", JSON.stringify(holds) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

function timersOf(ctx: ApiContext): Map<string, () => void> {
  let map = timers.get(ctx);
  if (!map) timers.set(ctx, (map = new Map()));
  return map;
}

function stopWait(ctx: ApiContext, linkId: string): void {
  timersOf(ctx).get(linkId)?.();
  timersOf(ctx).delete(linkId);
}

function schedule(ctx: ApiContext, linkId: string, until: number): void {
  stopWait(ctx, linkId);
  const timer = setTimeout(() => {
    timersOf(ctx).delete(linkId);
    expire(ctx, linkId);
  }, Math.max(0, until - Date.now()));
  // A one-shot leaves when its command is done; the next start takes the hold back.
  timer.unref?.();
  timersOf(ctx).set(linkId, () => clearTimeout(timer));
}

/**
 * Whether the chat leaves DHT only in this run: the engine switches only a chat it opened (`runnableTransports` is
 * there once it did). A one-shot that only reads opens none, and one about another chat not this one.
 */
const switchable = (link: LinkView | undefined): boolean => !link || link.deliveryMode !== "dht" || !!link.runnableTransports;

/**
 * A hold whose time is up ends. On a chat this run has not opened it ends once the chat opens, or at the next start
 * that opens it; it is no longer reported meanwhile (`holdOf`). Each read said on stderr that it "could not end:
 * Delivery method unavailable." and kept its past `heldUntil`.
 */
function expire(ctx: ApiContext, linkId: string): void {
  const opened = (links: readonly LinkView[]) => switchable(links.find((l) => l.id === linkId));
  if (!opened(state(ctx).links)) {
    const off = ctx.hub.onState((s) => { if (opened(s.links)) { stopWait(ctx, linkId); expire(ctx, linkId); } });
    timersOf(ctx).set(linkId, off);
    return;
  }
  void releaseHold(ctx, linkId, "expired").catch((error: unknown) => process.stderr.write(`ghostly: the hold on ${linkId} could not end: ${error instanceof Error ? error.message : String(error)}\n`));
}

/** When the chat's hold ends, or null (its time is up, also while it waits for the chat to open: `expire`). */
export function holdOf(ctx: ApiContext, linkId: string): number | null {
  const until = readHolds(ctx)[linkId]?.until;
  return until !== undefined && until > Date.now() ? until : null;
}

/** Keeps the chat off its direct link for `minutes` (again: from now). */
export async function holdChat(ctx: ApiContext, link: LinkView, minutes: number): Promise<number> {
  const holds = readHolds(ctx);
  if (link.deliveryMode === "dht" && !holds[link.id]) throw new CliError("refused", "This chat is on DHT only already, by its own choice: chat transport auto leaves it");
  if (!link.profile) throw new CliError("unavailable", "A chat of the older protocol has no DHT only");
  const until = Date.now() + minutes * 60_000;
  // The hold before DHT only, taken back if the switch fails: the store never has the chat on DHT only while
  // holds.json has no hold to end it (a profile backup reads that file again after the store).
  const before = holds[link.id];
  holds[link.id] = { until, since: before?.since ?? Date.now() };
  writeHolds(ctx, holds);
  if (link.deliveryMode !== "dht") {
    try { await node(ctx).setChatTransport({ linkId: link.id, transport: "dht" }); } catch (error) {
      const now = readHolds(ctx);
      if (before) now[link.id] = before; else delete now[link.id];
      writeHolds(ctx, now);
      throw new CliError("unavailable", error instanceof Error ? error.message : String(error));
    }
  }
  schedule(ctx, link.id, until);
  ctx.hub.emit("chat.held", `chat.held:${link.id}:${until}`, { chat: link.id, until });
  return until;
}

/**
 * Ends a hold: the chat leaves DHT only, unless someone chose otherwise meanwhile. Whether there was one. `reason`:
 * expired, connect (`chat connect`) or lifted (`--hold 0`, or `chat transport`: `chosen`, the chat's transport was
 * just chosen, and stays as chosen).
 */
export async function releaseHold(ctx: ApiContext, linkId: string, reason: "expired" | "connect" | "lifted", chosen = false): Promise<boolean> {
  const holds = readHolds(ctx);
  if (!holds[linkId]) return false;
  stopWait(ctx, linkId);
  const link = state(ctx).links.find((l) => l.id === linkId);
  if (!chosen && link?.deliveryMode === "dht") await node(ctx).setDeliveryMode({ linkId, mode: "stream" });
  delete holds[linkId];
  writeHolds(ctx, holds);
  ctx.hub.emit("chat.released", `chat.released:${linkId}:${Date.now()}`, { chat: linkId, reason });
  return true;
}

/** At start: holds whose time is up end now, the others are timed again. */
export function resumeHolds(ctx: ApiContext): void {
  for (const [linkId, hold] of Object.entries(readHolds(ctx))) schedule(ctx, linkId, hold.until);
}
