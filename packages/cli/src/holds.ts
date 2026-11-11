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

/**
 * Changes one chat's entry: the file is read again right here and written back in the same step, with no wait in
 * between, so what another chat's hold, expiry or release wrote meanwhile stays. Each call read the file before its
 * engine call and wrote that copy back after it: two holds at once on a daemon (which serves its connections at once)
 * kept only one, and the other chat stayed on DHT only for good; an expiry meanwhile brought an ended hold back.
 * Only one process writes the file: a command goes through the profile's daemon when one runs, and otherwise holds
 * the profile itself.
 */
function editHold(ctx: ApiContext, linkId: string, hold: Hold | null): void {
  const holds = readHolds(ctx);
  if (hold) holds[linkId] = hold;
  else if (holds[linkId]) delete holds[linkId];
  else return;
  writeHolds(ctx, holds);
}

/** Per profile folder and chat, the last change to its hold under way: changes to one chat's hold go one after another. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` once the changes to this chat's hold started before it are done (failed or not). A hold and an expiry,
 * a release or a removal of the same chat no longer run into each other; other chats' run meanwhile.
 */
function inTurn<T>(ctx: ApiContext, linkId: string, task: () => Promise<T>): Promise<T> {
  const key = `${ctx.runtime.paths.dir}\0${linkId}`;
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const settled = run.then(() => {}, () => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
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
export function holdChat(ctx: ApiContext, link: LinkView, minutes: number): Promise<number> {
  return inTurn(ctx, link.id, async () => {
    // As the chat is now: a change to its hold that ran first may have moved it.
    const now = state(ctx).links.find((l) => l.id === link.id) ?? link;
    const held = readHolds(ctx)[link.id];
    if (now.deliveryMode === "dht" && !held) throw new CliError("refused", "This chat is on DHT only already, by its own choice: chat transport auto leaves it");
    if (!now.profile) throw new CliError("unavailable", "A chat of the older protocol has no DHT only");
    const until = Date.now() + minutes * 60_000;
    // The hold before DHT only, taken back if the switch fails: the store never has the chat on DHT only while
    // holds.json has no hold to end it (a profile backup reads that file again after the store).
    editHold(ctx, link.id, { until, since: held?.since ?? Date.now() });
    if (now.deliveryMode !== "dht") {
      try { await node(ctx).setChatTransport({ linkId: link.id, transport: "dht" }); } catch (error) {
        editHold(ctx, link.id, held ?? null);
        throw new CliError("unavailable", error instanceof Error ? error.message : String(error));
      }
    }
    schedule(ctx, link.id, until);
    ctx.hub.emit("chat.held", `chat.held:${link.id}:${until}`, { chat: link.id, until });
    return until;
  });
}

/**
 * Ends a hold: the chat leaves DHT only, unless someone chose otherwise meanwhile. Whether there was one. `reason`:
 * expired, connect (`chat connect`) or lifted (`--hold 0`, or `chat transport`: `chosen`, the chat's transport was
 * just chosen, and stays as chosen).
 */
export function releaseHold(ctx: ApiContext, linkId: string, reason: "expired" | "connect" | "lifted", chosen = false): Promise<boolean> {
  return inTurn(ctx, linkId, async () => {
    if (!readHolds(ctx)[linkId]) return false;
    stopWait(ctx, linkId);
    const link = state(ctx).links.find((l) => l.id === linkId);
    if (!chosen && link?.deliveryMode === "dht") await node(ctx).setDeliveryMode({ linkId, mode: "stream" });
    editHold(ctx, linkId, null);
    ctx.hub.emit("chat.released", `chat.released:${linkId}:${Date.now()}`, { chat: linkId, reason });
    return true;
  });
}

/**
 * A removed chat's hold goes with it, with no release said: it stayed in the folder until its time was up (and in a
 * backup made meanwhile), a chat joined again from the same invite showed its `heldUntil`, and its end said
 * `chat.released` for a chat that was gone.
 */
export function forgetHold(ctx: ApiContext, linkId: string): Promise<void> {
  return inTurn(ctx, linkId, async () => {
    stopWait(ctx, linkId);
    editHold(ctx, linkId, null);
  });
}

/** At start: holds whose time is up end now, the others are timed again. */
export function resumeHolds(ctx: ApiContext): void {
  for (const [linkId, hold] of Object.entries(readHolds(ctx))) schedule(ctx, linkId, hold.until);
}
